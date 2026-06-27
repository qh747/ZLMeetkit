package adminauth_test

import (
	"testing"

	"zlm_meet/backend/pkg/adminauth"
)

func TestParseAccounts(t *testing.T) {
	got := adminauth.ParseAccounts(" admin:pass1 ; bob:secret:word ")
	if got["admin"] != "pass1" {
		t.Fatalf("admin password = %q", got["admin"])
	}
	if got["bob"] != "secret:word" {
		t.Fatalf("bob password = %q", got["bob"])
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 accounts, got %d", len(got))
	}
}

func TestParseAccountsEmptyAndInvalid(t *testing.T) {
	if len(adminauth.ParseAccounts("")) != 0 {
		t.Fatal("empty string should yield no accounts")
	}
	if len(adminauth.ParseAccounts("  ;  ; ")) != 0 {
		t.Fatal("blank segments should be ignored")
	}
	got := adminauth.ParseAccounts(":bad;nocolon")
	if len(got) != 0 {
		t.Fatalf("invalid segments should be ignored, got %#v", got)
	}
}

func TestLoginSuccessAndValidateToken(t *testing.T) {
	auth := adminauth.New(map[string]string{"admin": "pass"})

	token, err := auth.Login("admin", "pass")
	if err != nil {
		t.Fatal(err)
	}
	if token == "" {
		t.Fatal("expected non-empty token")
	}

	username, err := auth.ValidateToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if username != "admin" {
		t.Fatalf("username = %q", username)
	}
}

func TestLoginErrors(t *testing.T) {
	auth := adminauth.New(map[string]string{"admin": "pass"})

	cases := []struct {
		name     string
		username string
		password string
		wantErr  string
	}{
		{name: "not configured", username: "admin", password: "pass", wantErr: adminauth.ErrNotConfigured},
		{name: "wrong password", username: "admin", password: "bad", wantErr: adminauth.ErrInvalidAccount},
		{name: "unknown user", username: "ghost", password: "pass", wantErr: adminauth.ErrInvalidAccount},
	}

	empty := adminauth.New(map[string]string{})
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := auth
			if tc.name == "not configured" {
				a = empty
			}
			_, err := a.Login(tc.username, tc.password)
			if err == nil || err.Error() != tc.wantErr {
				t.Fatalf("Login() error = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestValidateTokenErrors(t *testing.T) {
	auth := adminauth.New(map[string]string{"admin": "pass"})

	cases := []struct {
		name    string
		token   string
		auth    *adminauth.Auth
		wantErr string
	}{
		{name: "empty token", token: "", wantErr: adminauth.ErrInvalidSession},
		{name: "unknown token", token: "missing", wantErr: adminauth.ErrInvalidSession},
		{name: "not configured", token: "any", auth: adminauth.New(map[string]string{}), wantErr: adminauth.ErrNotConfigured},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := auth
			if tc.auth != nil {
				a = tc.auth
			}
			_, err := a.ValidateToken(tc.token)
			if err == nil || err.Error() != tc.wantErr {
				t.Fatalf("ValidateToken() error = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestLoginSingleSession(t *testing.T) {
	auth := adminauth.New(map[string]string{"admin": "pass"})
	var kicked string
	auth.SetKickHandler(func(token string) { kicked = token })

	token1, err := auth.Login("admin", "pass")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := auth.ValidateToken(token1); err != nil {
		t.Fatal(err)
	}

	token2, err := auth.Login("admin", "pass")
	if err != nil {
		t.Fatal(err)
	}
	if kicked != token1 {
		t.Fatalf("expected kick %q, got %q", token1, kicked)
	}
	if _, err := auth.ValidateToken(token1); err == nil {
		t.Fatal("old token should be invalid")
	}
	_, err = auth.ValidateToken(token1)
	if err == nil || err.Error() != adminauth.ErrInvalidSession {
		t.Fatalf("old token error = %v", err)
	}
	if _, err := auth.ValidateToken(token2); err != nil {
		t.Fatal(err)
	}
}

func TestDifferentAdminsCanLoginConcurrently(t *testing.T) {
	auth := adminauth.New(map[string]string{
		"admin": "pass1",
		"ops":   "pass2",
	})

	tokenAdmin, err := auth.Login("admin", "pass1")
	if err != nil {
		t.Fatal(err)
	}
	tokenOps, err := auth.Login("ops", "pass2")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := auth.ValidateToken(tokenAdmin); err != nil {
		t.Fatal(err)
	}
	if _, err := auth.ValidateToken(tokenOps); err != nil {
		t.Fatal(err)
	}

	// Re-login ops should not invalidate admin.
	tokenOps2, err := auth.Login("ops", "pass2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := auth.ValidateToken(tokenAdmin); err != nil {
		t.Fatal("admin session should remain valid")
	}
	if _, err := auth.ValidateToken(tokenOps); err == nil {
		t.Fatal("old ops token should be invalid")
	}
	if _, err := auth.ValidateToken(tokenOps2); err != nil {
		t.Fatal(err)
	}
}
