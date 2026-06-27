package signaling_test

import (
	"testing"

	"zlm_meet/backend/pkg/signaling"
)

func TestCheckEntry_roomModeConflict(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c := signaling.NewTestClient("u1", "Alice", nil)
	if err := h.AddTestClient("1001", signaling.RoomModeMeeting, c); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("call", "1001", "Bob", "", "")
	if err == nil || err.Error() != signaling.ErrRoomInUse {
		t.Fatalf("want %q, got %v", signaling.ErrRoomInUse, err)
	}
}

func TestCheckEntry_duplicateNickname(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c := signaling.NewTestClient("u1", "Alice", nil)
	if err := h.AddTestClient("1001", signaling.RoomModeMeeting, c); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("meeting", "1001", "Alice", "", "")
	if err == nil || err.Error() != signaling.ErrUserInUse {
		t.Fatalf("want %q, got %v", signaling.ErrUserInUse, err)
	}
}

func TestCheckEntry_streamIDInUse(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c := signaling.NewTestClient("u1", "publisher", map[string]string{"solo": "demo_001"})
	if err := h.AddTestSoloClient("live", signaling.SoloRolePush, c); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("push", "live", "", "demo_001", "")
	if err == nil || err.Error() != signaling.ErrRoomInUse {
		t.Fatalf("want %q, got %v", signaling.ErrRoomInUse, err)
	}
}

func TestCheckEntry_streamNotFound(t *testing.T) {
	h := signaling.NewHub(nil, "")

	err := h.CheckEntry("play", "live", "", "missing", "")
	if err == nil || err.Error() != signaling.ErrStreamNotFound {
		t.Fatalf("want %q, got %v", signaling.ErrStreamNotFound, err)
	}

	c := signaling.NewTestClient("u1", "publisher", map[string]string{"solo": "demo_001"})
	if err := h.AddTestSoloClient("live", signaling.SoloRolePush, c); err != nil {
		t.Fatal(err)
	}

	err = h.CheckEntry("play", "live", "", "other", "")
	if err == nil || err.Error() != signaling.ErrStreamNotFound {
		t.Fatalf("want %q, got %v", signaling.ErrStreamNotFound, err)
	}
}

func TestCheckEntry_joinMeetingOK(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c := signaling.NewTestClient("u1", "Alice", nil)
	if err := h.AddTestClient("1001", signaling.RoomModeMeeting, c); err != nil {
		t.Fatal(err)
	}

	if err := h.CheckEntry("meeting", "1001", "Bob", "", ""); err != nil {
		t.Fatalf("join should pass: %v", err)
	}
}

func TestCheckEntry_playOK(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c := signaling.NewTestClient("u1", "publisher", map[string]string{"solo": "demo_001"})
	if err := h.AddTestSoloClient("live", signaling.SoloRolePush, c); err != nil {
		t.Fatal(err)
	}

	if err := h.CheckEntry("play", "live", "Bob", "demo_001", ""); err != nil {
		t.Fatalf("play should pass: %v", err)
	}
}

func TestCheckEntry_playNicknameRequired(t *testing.T) {
	h := signaling.NewHub(nil, "")
	c := signaling.NewTestClient("u1", "publisher", map[string]string{"solo": "demo_001"})
	if err := h.AddTestSoloClient("live", signaling.SoloRolePush, c); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("play", "live", "", "demo_001", "")
	if err == nil || err.Error() != signaling.ErrMemberNameRequired {
		t.Fatalf("want %q, got %v", signaling.ErrMemberNameRequired, err)
	}
}

func TestCheckEntry_playDuplicateMemberName(t *testing.T) {
	h := signaling.NewHub(nil, "")
	pub := signaling.NewTestClient("u1", "publisher", map[string]string{"solo": "demo_001"})
	if err := h.AddTestSoloClient("live", signaling.SoloRolePush, pub); err != nil {
		t.Fatal(err)
	}
	player := signaling.NewTestClient("u2", "Bob", nil)
	if err := h.AddTestSoloClient("live", signaling.SoloRolePlay, player); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("play", "live", "Bob", "demo_001", "")
	if err == nil || err.Error() != signaling.ErrMemberNameInUse {
		t.Fatalf("want %q, got %v", signaling.ErrMemberNameInUse, err)
	}
}

func TestCheckEntry_pushRoomOccupiedBeforeStream(t *testing.T) {
	h := signaling.NewHub(nil, "")
	pub := signaling.NewTestClient("u1", "publisher", nil)
	if err := h.AddTestSoloClient("live", signaling.SoloRolePush, pub); err != nil {
		t.Fatal(err)
	}

	err := h.CheckEntry("push", "live", "", "demo_002", "")
	if err == nil || err.Error() != signaling.ErrRoomInUse {
		t.Fatalf("want %q, got %v", signaling.ErrRoomInUse, err)
	}
}

func TestCheckEntry_tokenInvalid(t *testing.T) {
	h := signaling.NewHub(nil, "secret-token")

	err := h.CheckEntry("meeting", "1001", "Alice", "", "wrong")
	if err == nil || err.Error() != signaling.ErrTokenInvalid {
		t.Fatalf("want %q, got %v", signaling.ErrTokenInvalid, err)
	}
}

func TestCheckEntry_tokenOK(t *testing.T) {
	h := signaling.NewHub(nil, "secret-token")

	if err := h.CheckEntry("meeting", "1001", "Alice", "", "secret-token"); err != nil {
		t.Fatalf("valid token should pass: %v", err)
	}
}
