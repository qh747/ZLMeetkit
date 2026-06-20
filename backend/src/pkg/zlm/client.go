package zlm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"zlm_meet/backend/pkg/config"
)

// defaultVhost is hard-coded because vhost multi-tenancy is out of scope for
// this project; the ZLM default is fine for every supported deployment.
const defaultVhost = "__defaultVhost__"

// Client wraps the subset of ZLMediaKit's REST API that the signaling server needs.
// The ZLM "app" is supplied per-call by the caller, mapped from the front-end
// "room" input, so it is not stored on the client.
type Client struct {
	cfg        config.ZLMConfig
	httpClient *http.Client
	hookCache  hookCache // ZLM on_record_mp4 hook notifications
}

func New(cfg config.ZLMConfig) *Client {
	return &Client{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// ── Hook record cache ──────────────────────────────────────────────────────────
// ZLMediaKit can be configured with hook.on_record_mp4 pointing to our
// /api/zlm-hook/record-mp4 endpoint. When a recording completes, ZLM posts the
// file metadata and we cache it. ResolveLatestRecordURL checks this cache on
// each poll iteration, so the hook notification (when configured) eliminates
// the polling delay entirely.

type hookRecord struct {
	FullURL string    // complete playable HTTP URL (api_base + path)
	TS      time.Time
}

type hookCache struct {
	mu    sync.RWMutex
	items map[string]hookRecord // key: "app/stream"
}

// StoreHookRecord saves a ZLM on_record_mp4 notification so the file URL can
// be resolved immediately. callURL should be the complete playable URL
// (e.g. http://zlm:8081/record/live/pub/2026-06-21/file.mp4).
func (c *Client) StoreHookRecord(app, stream, callURL string) {
	c.hookCache.mu.Lock()
	defer c.hookCache.mu.Unlock()
	if c.hookCache.items == nil {
		c.hookCache.items = make(map[string]hookRecord)
	}
	key := app + "/" + stream
	c.hookCache.items[key] = hookRecord{FullURL: callURL, TS: time.Now()}
	if len(c.hookCache.items) > 128 {
		now := time.Now()
		for k, v := range c.hookCache.items {
			if now.Sub(v.TS) > 60*time.Second {
				delete(c.hookCache.items, k)
			}
		}
	}
}

// lookupHookRecord returns the cached hook URL, or "" if not found / stale.
func (c *Client) lookupHookRecord(app, stream string) (string, bool) {
	c.hookCache.mu.RLock()
	defer c.hookCache.mu.RUnlock()
	key := app + "/" + stream
	r, ok := c.hookCache.items[key]
	if !ok || time.Since(r.TS) > 30*time.Second {
		return "", false
	}
	return r.FullURL, true
}

// WebRTCType identifies whether SDP exchange is for browser publishing or playing.
type WebRTCType string

const (
	WebRTCPush WebRTCType = "push"
	WebRTCPlay WebRTCType = "play"
)

// webrtcResponse mirrors ZLM's /index/api/webrtc JSON response.
type webrtcResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Type string `json:"type"`
	SDP  string `json:"sdp"`
	ID   string `json:"id"`
}

// ExchangeSDP performs a WebRTC SDP offer/answer exchange with ZLM and returns
// the answer SDP. `app` is the ZLM stream group (front-end "room") and
// `stream` is unique within that app.
func (c *Client) ExchangeSDP(rtcType WebRTCType, app, stream, offerSDP string) (string, error) {
	q := url.Values{}
	q.Set("app", app)
	q.Set("stream", stream)
	q.Set("type", string(rtcType))
	q.Set("vhost", defaultVhost)

	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/webrtc?" + q.Encode()

	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(offerSDP))
	if err != nil {
		return "", fmt.Errorf("build webrtc request: %w", err)
	}
	req.Header.Set("Content-Type", "application/sdp")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("call webrtc api: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read webrtc response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("zlm webrtc http %d: %s", resp.StatusCode, string(body))
	}

	var parsed webrtcResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("decode webrtc response: %w (raw=%s)", err, string(body))
	}
	if parsed.Code != 0 {
		return "", fmt.Errorf("zlm webrtc error code=%d msg=%s", parsed.Code, parsed.Msg)
	}
	if parsed.SDP == "" {
		return "", fmt.Errorf("zlm webrtc returned empty sdp (raw=%s)", string(body))
	}
	return parsed.SDP, nil
}

// closeStreamsResponse mirrors ZLM /index/api/close_streams JSON response.
type closeStreamsResponse struct {
	Code       int `json:"code"`
	CountHit   int `json:"count_hit"`
	CountClose int `json:"count_closed"`
}

// RecordType identifies the recording container used by ZLM.
type RecordType int

const (
	RecordHLS RecordType = 0 // m3u8 + ts segments
	RecordMP4 RecordType = 1 // single mp4 file
)

// recordResponse mirrors the JSON shape of /startRecord, /stopRecord, /isRecording.
type recordResponse struct {
	Code   int    `json:"code"`
	Msg    string `json:"msg"`
	Result bool   `json:"result"`
}

// StartRecord asks ZLM to begin recording `stream` inside `app`.
func (c *Client) StartRecord(app, stream string, recordType RecordType) error {
	return c.recordCall("/index/api/startRecord", c.recordQuery(app, stream, recordType), "startRecord")
}

// StopRecord asks ZLM to stop recording `stream` inside `app`.
func (c *Client) StopRecord(app, stream string, recordType RecordType) error {
	return c.recordCall("/index/api/stopRecord", c.recordQuery(app, stream, recordType), "stopRecord")
}

// IsRecording queries ZLM for the current recording state.
func (c *Client) IsRecording(app, stream string, recordType RecordType) (bool, error) {
	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/isRecording?" + c.recordQuery(app, stream, recordType).Encode()
	resp, err := c.httpClient.Post(endpoint, "application/json", bytes.NewReader(nil))
	if err != nil {
		return false, fmt.Errorf("call isRecording: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("zlm isRecording http %d: %s", resp.StatusCode, string(body))
	}
	var parsed recordResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return false, fmt.Errorf("decode isRecording response: %w (raw=%s)", err, string(body))
	}
	if parsed.Code != 0 {
		return false, fmt.Errorf("zlm isRecording error code=%d msg=%s", parsed.Code, parsed.Msg)
	}
	return parsed.Result, nil
}

func (c *Client) recordQuery(app, stream string, recordType RecordType) url.Values {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("type", fmt.Sprintf("%d", recordType))
	q.Set("vhost", defaultVhost)
	q.Set("app", app)
	q.Set("stream", stream)
	return q
}

func (c *Client) recordCall(path string, q url.Values, label string) error {
	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + path + "?" + q.Encode()
	resp, err := c.httpClient.Post(endpoint, "application/json", bytes.NewReader(nil))
	if err != nil {
		return fmt.Errorf("call %s: %w", label, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("zlm %s http %d: %s", label, resp.StatusCode, string(body))
	}
	var parsed recordResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("decode %s response: %w (raw=%s)", label, err, string(body))
	}
	if parsed.Code != 0 {
		return fmt.Errorf("zlm %s error code=%d msg=%s", label, parsed.Code, parsed.Msg)
	}
	if !parsed.Result {
		return fmt.Errorf("zlm %s returned result=false (msg=%s)", label, parsed.Msg)
	}
	return nil
}

// mp4RecordResponse mirrors ZLM's /index/api/getMp4RecordFile JSON response.
type mp4RecordResponse struct {
	Code int            `json:"code"`
	Msg  string         `json:"msg"`
	Data *mp4RecordData `json:"data"`
}
type mp4RecordData struct {
	Paths    []string `json:"paths"`
	RootPath string   `json:"rootPath"`
}

// GetMp4RecordFiles returns recorded MP4 files (paths ending with .mp4) for a
// given app/stream on today's date. ZLM's API may also return bare directory
// entries — those are filtered out.
// The second return value is the rootPath from ZLM, which encodes the URL path
// prefix (everything after "www/") for constructing playable HTTP URLs.
func (c *Client) GetMp4RecordFiles(app, stream string) ([]string, string, error) {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("vhost", defaultVhost)
	q.Set("app", app)
	q.Set("stream", stream)

	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/getMp4RecordFile?" + q.Encode()
	resp, err := c.httpClient.Get(endpoint)
	if err != nil {
		return nil, "", fmt.Errorf("call getMp4RecordFile: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", fmt.Errorf("read getMp4RecordFile response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("zlm getMp4RecordFile http %d: %s", resp.StatusCode, string(body))
	}
	var parsed mp4RecordResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, "", fmt.Errorf("decode getMp4RecordFile: %w (raw=%s)", err, string(body))
	}
	if parsed.Code != 0 {
		return nil, "", fmt.Errorf("zlm getMp4RecordFile error code=%d msg=%s", parsed.Code, parsed.Msg)
	}
	if parsed.Data == nil || len(parsed.Data.Paths) == 0 {
		return nil, "", nil // no recordings found
	}

	// Filter: only return paths that are actual .mp4 files, not bare directories.
	files := make([]string, 0, len(parsed.Data.Paths))
	for _, p := range parsed.Data.Paths {
		if strings.HasSuffix(p, ".mp4") {
			files = append(files, p)
		}
	}
	rootPath := parsed.Data.RootPath
	if len(files) == 0 {
		return nil, rootPath, nil
	}
	return files, rootPath, nil
}

// buildRecordURLPrefix extracts the HTTP-accessible path prefix from ZLM's
// rootPath. ZLM serves its www/ directory at its HTTP root, so a rootPath of
// "/path/to/www/record/live/pub/" maps to URL prefix "/record/live/pub/".
func buildRecordURLPrefix(rootPath string) string {
	idx := strings.Index(rootPath, "www/")
	if idx < 0 {
		return "/"
	}
	prefix := rootPath[idx+4:] // skip "www/"
	// Ensure it ends with /
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	if !strings.HasPrefix(prefix, "/") {
		prefix = "/" + prefix
	}
	return prefix
}

// RecordMp4HookPayload mirrors ZLM on_record_mp4 hook JSON body.
// See: https://docs.zlmediakit.com/guide/media_server/web_hook_api.html
type RecordMp4HookPayload struct {
	MediaServerID string  `json:"mediaServerId"`
	App           string  `json:"app"`
	Stream        string  `json:"stream"`
	Vhost         string  `json:"vhost"`
	FileName      string  `json:"file_name"`
	FilePath      string  `json:"file_path"`
	Folder        string  `json:"folder"`
	FileSize      int64   `json:"file_size"`
	StartTime     int64   `json:"start_time"`
	TimeLen       float64 `json:"time_len"`
	URL           string  `json:"url"` // relative HTTP path under ZLM www/
	HookIndex     int     `json:"hook_index"`
	Params        string  `json:"params"`
}

// BuildRecordURLFromHook turns hook fields into a full playable HTTP URL.
// Priority: url → file_path (www-relative) → folder+file_name via file_path date dir.
func BuildRecordURLFromHook(apiBase string, h *RecordMp4HookPayload) string {
	base := strings.TrimRight(apiBase, "/")

	rel := strings.TrimSpace(h.URL)
	if rel == "" {
		rel = FilePathToHTTP(h.FilePath)
	}
	if rel == "" && h.FileName != "" && h.FilePath != "" {
		// file_path contains the date sub-folder: .../2026-06-21/file_name.mp4
		if idx := strings.LastIndex(h.FilePath, "/"); idx >= 0 {
			parent := h.FilePath[:idx] // .../2026-06-21
			if j := strings.LastIndex(parent, "/"); j >= 0 {
				dateDir := parent[j+1:]
				prefix := buildRecordURLPrefix(h.Folder)
				rel = strings.Trim(prefix, "/") + "/" + dateDir + "/" + h.FileName
			}
		}
	}
	if rel == "" {
		return ""
	}
	return base + "/" + strings.TrimLeft(rel, "/")
}
// ZLM serves everything under its www/ directory at the HTTP root.
//
// Example:
//
//	/home/.../www/record/live/pub/2026-06-21/file.mp4  →  /record/live/pub/2026-06-21/file.mp4
func FilePathToHTTP(abs string) string {
	idx := strings.Index(abs, "www/")
	if idx < 0 {
		idx = strings.Index(abs, "www" + string('/'))
	}
	if idx < 0 {
		return ""
	}
	rel := abs[idx+4:] // skip "www/"
	if !strings.HasPrefix(rel, "/") {
		rel = "/" + rel
	}
	return rel
}

// ResolveLatestRecordURL resolves a playable HTTP URL for the most recent
// recording of (app, stream) with two sources:
//
//  1. ZLM hook cache — if hook.on_record_mp4 has fired, return immediately.
//  2. ZLM getMp4RecordFile API — polled as fallback (10 retries × 500ms).
func (c *Client) ResolveLatestRecordURL(app, stream string) (string, error) {
	// Wait for ZLM hook (on_record_mp4) which carries file_name + url.
	// Poll cache up to 10 times; fall back to getMp4RecordFile API if hook is slow.
	var lastErr error
	for i := 0; i < 10; i++ {
		if u, ok := c.lookupHookRecord(app, stream); ok {
			return u, nil
		}

		paths, rootPath, err := c.GetMp4RecordFiles(app, stream)
		if err != nil {
			lastErr = err
		} else if len(paths) > 0 {
			latestFile := paths[len(paths)-1]
			urlPrefix := buildRecordURLPrefix(rootPath)
			base := strings.TrimRight(c.cfg.APIBase, "/")
			urlPrefix = strings.TrimPrefix(urlPrefix, "/")
			return base + "/" + urlPrefix + latestFile, nil
		} else {
			lastErr = fmt.Errorf("waiting for hook notification (app=%s stream=%s)", app, stream)
		}
		time.Sleep(500 * time.Millisecond)
	}
	return "", fmt.Errorf("resolve record url after 10 retries: %w", lastErr)
}

// CloseStream forcibly closes a single stream (all schemas) within `app`.
// Used when a user leaves the room or stops sharing their screen.
func (c *Client) CloseStream(app, stream string) error {
	q := url.Values{}
	q.Set("secret", c.cfg.Secret)
	q.Set("vhost", defaultVhost)
	q.Set("app", app)
	q.Set("stream", stream)
	q.Set("force", "1")

	endpoint := strings.TrimRight(c.cfg.APIBase, "/") + "/index/api/close_streams?" + q.Encode()
	resp, err := c.httpClient.Post(endpoint, "application/json", bytes.NewReader(nil))
	if err != nil {
		return fmt.Errorf("call close_streams: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("zlm close_streams http %d: %s", resp.StatusCode, string(body))
	}
	var parsed closeStreamsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("decode close_streams response: %w (raw=%s)", err, string(body))
	}
	// code==0 includes the case where stream wasn't found; we only log upstream.
	if parsed.Code != 0 {
		return fmt.Errorf("zlm close_streams error code=%d", parsed.Code)
	}
	return nil
}
