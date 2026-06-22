package signaling

import "testing"

func TestCheckEntry_roomModeConflict(t *testing.T) {
	h := NewHub(nil)
	room := h.GetOrCreateRoom("1001", RoomModeMeeting)
	c := &Client{UserID: "u1", Nickname: "Alice"}
	_ = room.addClient(c, RoomModeMeeting)

	err := h.CheckEntry("call", "1001", "Bob", "")
	if err == nil || err.Error() != ErrRoomInUse {
		t.Fatalf("want %q, got %v", ErrRoomInUse, err)
	}
}

func TestCheckEntry_duplicateNickname(t *testing.T) {
	h := NewHub(nil)
	room := h.GetOrCreateRoom("1001", RoomModeMeeting)
	c := &Client{UserID: "u1", Nickname: "Alice"}
	_ = room.addClient(c, RoomModeMeeting)

	err := h.CheckEntry("meeting", "1001", "Alice", "")
	if err == nil || err.Error() != ErrUserInUse {
		t.Fatalf("want %q, got %v", ErrUserInUse, err)
	}
}

func TestCheckEntry_streamIDInUse(t *testing.T) {
	h := NewHub(nil)
	room := h.GetOrCreateRoom("live", RoomModeSolo)
	c := &Client{UserID: "u1", Nickname: "publisher", streams: map[string]string{"solo": "demo_001"}}
	_ = room.addClient(c, RoomModeSolo)

	err := h.CheckEntry("push", "live", "", "demo_001")
	if err == nil || err.Error() != ErrStreamIDInUse {
		t.Fatalf("want %q, got %v", ErrStreamIDInUse, err)
	}
}

func TestCheckEntry_streamNotFound(t *testing.T) {
	h := NewHub(nil)

	err := h.CheckEntry("play", "live", "", "missing")
	if err == nil || err.Error() != ErrStreamNotFound {
		t.Fatalf("want %q, got %v", ErrStreamNotFound, err)
	}

	room := h.GetOrCreateRoom("live", RoomModeSolo)
	c := &Client{UserID: "u1", Nickname: "publisher", streams: map[string]string{"solo": "demo_001"}}
	_ = room.addClient(c, RoomModeSolo)

	err = h.CheckEntry("play", "live", "", "other")
	if err == nil || err.Error() != ErrStreamNotFound {
		t.Fatalf("want %q, got %v", ErrStreamNotFound, err)
	}
}

func TestCheckEntry_joinMeetingOK(t *testing.T) {
	h := NewHub(nil)
	room := h.GetOrCreateRoom("1001", RoomModeMeeting)
	c := &Client{UserID: "u1", Nickname: "Alice"}
	_ = room.addClient(c, RoomModeMeeting)

	if err := h.CheckEntry("meeting", "1001", "Bob", ""); err != nil {
		t.Fatalf("join should pass: %v", err)
	}
}

func TestCheckEntry_playOK(t *testing.T) {
	h := NewHub(nil)
	room := h.GetOrCreateRoom("live", RoomModeSolo)
	c := &Client{UserID: "u1", Nickname: "publisher", streams: map[string]string{"solo": "demo_001"}}
	_ = room.addClient(c, RoomModeSolo)

	if err := h.CheckEntry("play", "live", "", "demo_001"); err != nil {
		t.Fatalf("play should pass: %v", err)
	}
}
