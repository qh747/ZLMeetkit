package adminauth

import (
	"errors"
	"sync"

	"github.com/google/uuid"
)

const (
	ErrNotConfigured  = "未配置管理员账号"
	ErrInvalidAccount = "管理员名称或密码错误"
	ErrInvalidSession = "登录已失效，请重新登录"
)

// Auth manages admin credentials and single-session login per username.
type Auth struct {
	mu       sync.Mutex
	accounts map[string]string
	sessions map[string]string // token → username
	byUser   map[string]string // username → token
	onKick   func(token string)
}

func New(accounts map[string]string) *Auth {
	if accounts == nil {
		accounts = map[string]string{}
	}
	return &Auth{
		accounts: accounts,
		sessions: make(map[string]string),
		byUser:   make(map[string]string),
	}
}

// SetKickHandler is called when an existing session is replaced by a new login.
func (a *Auth) SetKickHandler(fn func(token string)) {
	a.mu.Lock()
	a.onKick = fn
	a.mu.Unlock()
}

// Login validates credentials and returns a new session token.
// If the username already has an active session, that session is invalidated first.
func (a *Auth) Login(username, password string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if len(a.accounts) == 0 {
		return "", errors.New(ErrNotConfigured)
	}
	stored, ok := a.accounts[username]
	if !ok || stored != password {
		return "", errors.New(ErrInvalidAccount)
	}

	if oldToken, ok := a.byUser[username]; ok {
		delete(a.sessions, oldToken)
		delete(a.byUser, username)
		if a.onKick != nil {
			a.onKick(oldToken)
		}
	}

	token := uuid.NewString()
	a.sessions[token] = username
	a.byUser[username] = token
	return token, nil
}

// ValidateToken returns the username for a valid session token.
func (a *Auth) ValidateToken(token string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if len(a.accounts) == 0 {
		return "", errors.New(ErrNotConfigured)
	}
	if token == "" {
		return "", errors.New(ErrInvalidSession)
	}
	username, ok := a.sessions[token]
	if !ok {
		return "", errors.New(ErrInvalidSession)
	}
	return username, nil
}

// Logout invalidates an admin session token.
func (a *Auth) Logout(token string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if len(a.accounts) == 0 {
		return errors.New(ErrNotConfigured)
	}
	username, ok := a.sessions[token]
	if !ok {
		return errors.New(ErrInvalidSession)
	}
	delete(a.sessions, token)
	delete(a.byUser, username)
	return nil
}
