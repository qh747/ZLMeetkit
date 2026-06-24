package signaling

// NewTestClient builds a client for tests under backend/test.
func NewTestClient(userID, nickname string, streams map[string]string) *Client {
	if streams == nil {
		streams = make(map[string]string)
	}
	return &Client{
		UserID:     userID,
		Nickname:   nickname,
		streams:    streams,
		recordings: make(map[string]bool),
	}
}

// AddTestClient registers a synthetic client in the hub (for external tests).
func (h *Hub) AddTestClient(roomID, mode string, c *Client) error {
	r := h.GetOrCreateRoom(roomID, mode)
	return r.addClient(c, mode)
}
