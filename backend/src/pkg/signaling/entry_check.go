package signaling

import (
	"errors"
	"strings"
)

// Entry check error messages returned to the home page.
const (
	ErrRoomInUse         = "房间已经被使用"
	ErrUserInUse         = "用户已经被使用"
	ErrMemberNameInUse   = "成员名称已被使用"
	ErrMemberNameRequired = "成员名称不能为空"
	ErrStreamIDInUse     = "流id已经被使用"
	ErrStreamNotFound    = "流不存在"
)

// bizToMode maps front-end business keys to signaling room modes.
func bizToMode(biz string) string {
	switch biz {
	case "call":
		return RoomModeCall
	case "push", "play":
		return RoomModeSolo
	default:
		return RoomModeMeeting
	}
}

// CheckEntry validates home-page form input against active signaling state.
// All checks are in-memory on the hub; ZLM is not queried.
func (h *Hub) CheckEntry(biz, room, nickname, streamID string) error {
	biz = strings.TrimSpace(biz)
	room = strings.TrimSpace(room)
	nickname = strings.TrimSpace(nickname)
	streamID = strings.TrimSpace(streamID)

	if room == "" {
		return errors.New("room is required")
	}

	mode := bizToMode(biz)
	r, exists := h.GetRoom(room)

	switch biz {
	case "meeting", "call", "push":
		if exists && r.size() > 0 {
			if r.Mode != mode {
				return errors.New(ErrRoomInUse)
			}
			if nickname != "" && r.hasNickname(nickname) {
				return errors.New(ErrUserInUse)
			}
		}
		if biz == "push" && streamID != "" && exists && r.hasStreamID(streamID) {
			return errors.New(ErrStreamIDInUse)
		}
		return nil

	case "play":
		if !exists || r.size() == 0 || r.Mode != RoomModeSolo {
			return errors.New(ErrStreamNotFound)
		}
		if streamID == "" || !r.hasStreamID(streamID) {
			return errors.New(ErrStreamNotFound)
		}
		if nickname == "" {
			return errors.New(ErrMemberNameRequired)
		}
		if r.hasNickname(nickname) {
			return errors.New(ErrMemberNameInUse)
		}
		return nil

	default:
		return errors.New("invalid biz")
	}
}
