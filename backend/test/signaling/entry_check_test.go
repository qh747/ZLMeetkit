package signaling_test

import (
	"testing"

	"zlm_meet/backend/pkg/signaling"
)

func TestCheckEntry_roomModeConflict(t *testing.T) {
	h := signaling.NewHub(nil)
	c := signaling.NewTestClient("u1", "Alice", nil)
	if err := h.AddTestClient("1001", signaling.RoomModeMeeting, c); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("call", "1001", "Bob", "")
	if err == nil || err.Error() != signaling.ErrRoomInUse {
		t.Fatalf("want %q, got %v", signaling.ErrRoomInUse, err)
	}
}

func TestCheckEntry_duplicateNickname(t *testing.T) {
	h := signaling.NewHub(nil)
	c := signaling.NewTestClient("u1", "Alice", nil)
	if err := h.AddTestClient("1001", signaling.RoomModeMeeting, c); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("meeting", "1001", "Alice", "")
	if err == nil || err.Error() != signaling.ErrUserInUse {
		t.Fatalf("want %q, got %v", signaling.ErrUserInUse, err)
	}
}

func TestCheckEntry_streamIDInUse(t *testing.T) {
	h := signaling.NewHub(nil)
	c := signaling.NewTestClient("u1", "publisher", map[string]string{"solo": "demo_001"})
	if err := h.AddTestClient("live", signaling.RoomModeSolo, c); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("push", "live", "", "demo_001")
	if err == nil || err.Error() != signaling.ErrStreamIDInUse {
		t.Fatalf("want %q, got %v", signaling.ErrStreamIDInUse, err)
	}
}

func TestCheckEntry_streamNotFound(t *testing.T) {
	h := signaling.NewHub(nil)

	err := h.CheckEntry("play", "live", "", "missing")
	if err == nil || err.Error() != signaling.ErrStreamNotFound {
		t.Fatalf("want %q, got %v", signaling.ErrStreamNotFound, err)
	}

	c := signaling.NewTestClient("u1", "publisher", map[string]string{"solo": "demo_001"})
	if err := h.AddTestClient("live", signaling.RoomModeSolo, c); err != nil {
		t.Fatal(err)
	}

	err = h.CheckEntry("play", "live", "", "other")
	if err == nil || err.Error() != signaling.ErrStreamNotFound {
		t.Fatalf("want %q, got %v", signaling.ErrStreamNotFound, err)
	}
}

func TestCheckEntry_joinMeetingOK(t *testing.T) {
	h := signaling.NewHub(nil)
	c := signaling.NewTestClient("u1", "Alice", nil)
	if err := h.AddTestClient("1001", signaling.RoomModeMeeting, c); err != nil {
		t.Fatal(err)
	}

	if err := h.CheckEntry("meeting", "1001", "Bob", ""); err != nil {
		t.Fatalf("join should pass: %v", err)
	}
}

func TestCheckEntry_playOK(t *testing.T) {
	h := signaling.NewHub(nil)
	c := signaling.NewTestClient("u1", "publisher", map[string]string{"solo": "demo_001"})
	if err := h.AddTestClient("live", signaling.RoomModeSolo, c); err != nil {
		t.Fatal(err)
	}

	if err := h.CheckEntry("play", "live", "", "demo_001"); err != nil {
		t.Fatalf("play should pass: %v", err)
	}
}
