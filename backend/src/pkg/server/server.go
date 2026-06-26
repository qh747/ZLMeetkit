package server

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"zlm_meet/backend/pkg/config"
	"zlm_meet/backend/pkg/signaling"
	"zlm_meet/backend/pkg/zlm"
)

// New builds an http.Handler with WebSocket signaling and static file serving.
func New(cfg *config.Config, hub *signaling.Hub) http.Handler {
	mux := http.NewServeMux()

	upgrader := &websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin:     buildOriginChecker(cfg.AllowedOrigins),
	}

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		signaling.ServeWS(hub, upgrader, w, r)
	})

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("/api/entry-check", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Biz      string `json:"biz"`
			Room     string `json:"room"`
			Nickname string `json:"nickname,omitempty"`
			StreamID string `json:"streamId,omitempty"`
			Token    string `json:"token,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := hub.CheckEntry(req.Biz, req.Room, req.Nickname, req.StreamID, req.Token); err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      false,
				"message": err.Error(),
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})

	mux.HandleFunc("/debug/rooms", func(w http.ResponseWriter, r *http.Request) {
		// Lightweight introspection; do not expose in production.
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"note": "see logs for details"})
	})

	// ZLM on_record_mp4 hook receiver. Configure ZLM's hook.on_record_mp4 to
	// point to this endpoint (e.g. http://your-server:8080/api/zlm-hook/record-mp4).
	// When ZLM finishes writing an MP4 recording file, it POSTs the metadata here,
	// allowing us to resolve the file URL immediately without polling the API.
	mux.HandleFunc("/api/zlm-hook/record-mp4", func(w http.ResponseWriter, r *http.Request) {
		writeZLMHookOK := func() {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
		}
		if r.Method != http.MethodPost {
			writeZLMHookOK()
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			log.Printf("[zlm-hook] read body: %v", err)
			writeZLMHookOK() // on_record_mp4 is fire-and-forget; always ack 200
			return
		}

		var h zlm.RecordMp4HookPayload
		if err := json.Unmarshal(body, &h); err != nil {
			log.Printf("[zlm-hook] unmarshal: %v raw=%s", err, string(body))
			writeZLMHookOK()
			return
		}
		if h.App == "" || h.Stream == "" {
			log.Printf("[zlm-hook] missing app/stream: %s", string(body))
			writeZLMHookOK()
			return
		}

		fullURL := zlm.BuildRecordURLFromHook(cfg.ZLM.APIBase, &h)
		if fullURL == "" {
			log.Printf("[zlm-hook] cannot build url from hook: app=%s stream=%s file_name=%s url=%q file_path=%q",
				h.App, h.Stream, h.FileName, h.URL, h.FilePath)
			writeZLMHookOK()
			return
		}

		hub.ZLM().StoreHookRecord(h.App, h.Stream, fullURL)
		log.Printf("[zlm-hook] record: app=%s stream=%s file=%s size=%d len=%.1fs url=%s",
			h.App, h.Stream, h.FileName, h.FileSize, h.TimeLen, fullURL)
		writeZLMHookOK()
	})

	// Proxy recording file access from ZLM's HTTP server. Supports both inline
	// preview (with Range forwarding for HTML5 <video>) and download.
	// Using a single origin-proxy avoids cross-origin issues and ensures the
	// correct Content-Type is served regardless of ZLM's built-in MIME handling.
	mux.HandleFunc("/api/record-file", func(w http.ResponseWriter, r *http.Request) {
		fileURL := r.URL.Query().Get("url")
		if fileURL == "" {
			http.Error(w, "missing url", http.StatusBadRequest)
			return
		}
		// Security: only proxy URLs that point to the configured ZLM server.
		if !strings.HasPrefix(fileURL, cfg.ZLM.APIBase) {
			http.Error(w, "invalid url", http.StatusForbidden)
			return
		}
		mode := r.URL.Query().Get("mode")

		ctx := r.Context()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, fileURL, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Forward Range header — required for HTML5 <video> seeking/buffering.
		if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}

		client := &http.Client{Timeout: 60 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		// Only accept 200 OK or 206 Partial Content from ZLM.
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			body, _ := io.ReadAll(resp.Body)
			log.Printf("[record-file] zlm returned HTTP %d for %s: %s", resp.StatusCode, fileURL, string(body))
			http.Error(w, "upstream error", http.StatusBadGateway)
			return
		}

		// Force Content-Type to video/mp4 regardless of what ZLM returns.
		w.Header().Set("Content-Type", "video/mp4")

		if mode == "download" {
			filename := r.URL.Query().Get("filename")
			if filename == "" {
				filename = "record.mp4"
			}
			w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		}

		// Forward headers needed for HTML5 video playback.
		if cl := resp.Header.Get("Content-Length"); cl != "" {
			w.Header().Set("Content-Length", cl)
		}
		if cr := resp.Header.Get("Content-Range"); cr != "" {
			w.Header().Set("Content-Range", cr)
		}
		if ar := resp.Header.Get("Accept-Ranges"); ar != "" {
			w.Header().Set("Accept-Ranges", ar)
		}

		// Preserve 206 Partial Content status when serving a range.
		if resp.StatusCode == http.StatusPartialContent {
			w.WriteHeader(http.StatusPartialContent)
		}

		_, _ = io.Copy(w, resp.Body)
	})

	if cfg.StaticDir != "" {
		fs := http.FileServer(http.Dir(cfg.StaticDir))
		mux.Handle("/", fs)
		log.Printf("[server] serving static files from %s", cfg.StaticDir)
	}

	return mux
}

func buildOriginChecker(allowed []string) func(r *http.Request) bool {
	if len(allowed) == 0 {
		// No allow-list configured: permit all (dev mode).
		return func(_ *http.Request) bool { return true }
	}
	allowSet := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		allowSet[o] = struct{}{}
	}
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser clients
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		_, ok := allowSet[u.Scheme+"://"+u.Host]
		return ok
	}
}
