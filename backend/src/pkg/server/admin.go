package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/rs/zerolog/log"

	"zlm_meet/backend/pkg/adminauth"
	"zlm_meet/backend/pkg/config"
	"zlm_meet/backend/pkg/signaling"
)

const adminTokenHeader = "X-Admin-Token"

// NewAdmin builds the HTTPS admin handler (API + static admin UI).
func NewAdmin(cfg *config.Config, hub *signaling.Hub, auth *adminauth.Auth) http.Handler {
	mux := http.NewServeMux()
	audit := NewAuditLog(200)
	observeMgr := newObserveSessionManager(hub, auth, audit)
	dashboardHub := newAdminDashboardHub(hub, auth, observeMgr)
	originCheck := buildOriginChecker(cfg.AllowedOrigins)

	mux.HandleFunc("/api/admin/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		token, err := auth.Login(strings.TrimSpace(req.Username), req.Password)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      false,
				"message": err.Error(),
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":    true,
			"token": token,
		})
	})

	mux.Handle("/api/admin/dashboard", requireAdmin(auth, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(buildDashboardPayload(hub, true))
	}))

	mux.HandleFunc("/api/admin/ws", func(w http.ResponseWriter, r *http.Request) {
		dashboardHub.handleWS(w, r, originCheck)
	})

	mux.HandleFunc("/api/admin/logout", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		token := strings.TrimSpace(r.Header.Get(adminTokenHeader))
		username, err := auth.ValidateToken(token)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "message": err.Error()})
			return
		}
		observeMgr.leaveAllByToken(token, "logout")
		if err := auth.Logout(token); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "message": err.Error()})
			return
		}
		audit.Record(username, "logout", "", "")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	})

	mux.Handle("/api/admin/audit-log", requireAdmin(auth, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		limit := 50
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"entries": audit.Recent(limit)})
	}))

	mux.HandleFunc("/api/admin/observe/ws", func(w http.ResponseWriter, r *http.Request) {
		observeMgr.handleWS(w, r, originCheck)
	})

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	// Admin UI lives under admin_static_dir but reuses shared css/assets from the
	// business frontend tree (see frontend/admin/index.html).
	sharedRoot := cfg.StaticDir
	if sharedRoot == "" && cfg.AdminStaticDir != "" {
		sharedRoot = filepath.Dir(cfg.AdminStaticDir)
	}
	if sharedRoot != "" {
		mux.Handle("/css/", cssHandler(cfg.AdminStaticDir, sharedRoot))
		mux.Handle("/js/", jsHandler(cfg.AdminStaticDir, sharedRoot))
		mux.Handle("/assets/", assetsHandler(cfg.AdminStaticDir, sharedRoot))
	} else if cfg.AdminStaticDir != "" {
		mux.Handle("/assets/", assetsHandler(cfg.AdminStaticDir, ""))
	}

	if cfg.AdminStaticDir != "" {
		adminFS := http.FileServer(http.Dir(cfg.AdminStaticDir))
		mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := r.URL.Path
			if strings.HasPrefix(p, "/assets/") || strings.HasPrefix(p, "/css/") || strings.HasPrefix(p, "/js/") || strings.HasPrefix(p, "/api/") {
				http.NotFound(w, r)
				return
			}
			adminFS.ServeHTTP(w, r)
		}))
		log.Info().Str("path", cfg.AdminStaticDir).Msg("serving admin static files")
	}

	return mux
}

// cssHandler serves admin-local styles first, then falls back to the shared frontend css dir.
func cssHandler(adminStaticDir, sharedRoot string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/css/")
		if name == "" || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		if adminStaticDir != "" {
			adminPath := filepath.Join(adminStaticDir, "css", name)
			if info, err := os.Stat(adminPath); err == nil && !info.IsDir() {
				http.ServeFile(w, r, adminPath)
				return
			}
		}
		sharedPath := filepath.Join(sharedRoot, "css", name)
		if info, err := os.Stat(sharedPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, sharedPath)
			return
		}
		http.NotFound(w, r)
	})
}

func jsHandler(adminStaticDir, sharedRoot string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/js/")
		if name == "" || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		if adminStaticDir != "" {
			adminPath := filepath.Join(adminStaticDir, "js", name)
			if info, err := os.Stat(adminPath); err == nil && !info.IsDir() {
				http.ServeFile(w, r, adminPath)
				return
			}
		}
		sharedPath := filepath.Join(sharedRoot, "js", name)
		if info, err := os.Stat(sharedPath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, sharedPath)
			return
		}
		http.NotFound(w, r)
	})
}

// assetsHandler serves admin-local assets first, then falls back to the shared frontend assets dir.
func assetsHandler(adminStaticDir, sharedRoot string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/assets/")
		if name == "" || strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		var filePath string
		if adminStaticDir != "" {
			adminPath := filepath.Join(adminStaticDir, "assets", name)
			if info, err := os.Stat(adminPath); err == nil && !info.IsDir() {
				filePath = adminPath
			}
		}
		if filePath == "" && sharedRoot != "" {
			sharedPath := filepath.Join(sharedRoot, "assets", name)
			if info, err := os.Stat(sharedPath); err == nil && !info.IsDir() {
				filePath = sharedPath
			}
		}
		if filePath == "" {
			http.NotFound(w, r)
			return
		}
		if strings.HasSuffix(strings.ToLower(name), ".svg") {
			w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		}
		http.ServeFile(w, r, filePath)
	})
}

func requireAdmin(auth *adminauth.Auth, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimSpace(r.Header.Get(adminTokenHeader))
		if _, err := auth.ValidateToken(token); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":      false,
				"message": err.Error(),
			})
			return
		}
		next(w, r)
	})
}
