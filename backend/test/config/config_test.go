package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"zlm_meet/backend/pkg/adminauth"
	"zlm_meet/backend/pkg/config"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

const validTail = `
tls_cert: "cert.pem"
tls_key: "key.pem"
admin_static_dir: "../../frontend/admin"
admin_accounts: "admin:pass;ops:secret"
zlm:
  api_base: "http://127.0.0.1:8081"
  secret: "secret"
`

func TestLoadRequiresListenPorts(t *testing.T) {
	cases := []struct {
		name    string
		extra   string
		wantErr string
	}{
		{
			name:    "missing listen",
			extra:   "admin_listen: \":9443\"\n",
			wantErr: "listen is required",
		},
		{
			name:    "missing admin_listen",
			extra:   "listen: \":7443\"\n",
			wantErr: "admin_listen is required",
		},
		{
			name:    "same port",
			extra:   "listen: \":7443\"\nadmin_listen: \":7443\"\n",
			wantErr: "listen and admin_listen must be different",
		},
		{
			name:    "whitespace-only listen",
			extra:   "listen: \"   \"\nadmin_listen: \":9443\"\n",
			wantErr: "listen is required",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeConfig(t, tc.extra+validTail)
			_, err := config.Load(path)
			if err == nil || err.Error() != tc.wantErr {
				t.Fatalf("Load() error = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestLoadRequiresTLS(t *testing.T) {
	portSection := `
listen: ":7443"
admin_listen: ":9443"
admin_static_dir: "../../frontend/admin"
admin_accounts: "admin:pass"
zlm:
  api_base: "http://127.0.0.1:8081"
  secret: "secret"
`
	cases := []struct {
		name    string
		body    string
		wantErr string
	}{
		{
			name:    "missing tls_cert",
			body:    portSection + "tls_key: \"key.pem\"\n",
			wantErr: "tls_cert is required (HTTPS only)",
		},
		{
			name:    "missing tls_key",
			body:    portSection + "tls_cert: \"cert.pem\"\n",
			wantErr: "tls_key is required (HTTPS only)",
		},
		{
			name: "whitespace-only tls_cert",
			body: portSection + `
tls_cert: "   "
tls_key: "key.pem"
`,
			wantErr: "tls_cert is required (HTTPS only)",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeConfig(t, tc.body)
			_, err := config.Load(path)
			if err == nil || err.Error() != tc.wantErr {
				t.Fatalf("Load() error = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestLoadAcceptsValidConfig(t *testing.T) {
	path := writeConfig(t, `
listen: " :7443 "
admin_listen: " :9443 "
tls_cert: " cert.pem "
tls_key: " key.pem "
admin_static_dir: "../../frontend/admin"
admin_accounts: "admin:pass;ops:secret"
zlm:
  api_base: "http://127.0.0.1:8081"
  secret: "secret"
`)

	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":7443" || cfg.AdminListen != ":9443" {
		t.Fatalf("ports = %q / %q", cfg.Listen, cfg.AdminListen)
	}
	if cfg.TLSCert != "cert.pem" || cfg.TLSKey != "key.pem" {
		t.Fatalf("tls = %q / %q", cfg.TLSCert, cfg.TLSKey)
	}
	if cfg.AdminAccounts != "admin:pass;ops:secret" {
		t.Fatalf("admin_accounts = %q", cfg.AdminAccounts)
	}

	accounts := adminauth.ParseAccounts(cfg.AdminAccounts)
	if accounts["admin"] != "pass" || accounts["ops"] != "secret" {
		t.Fatalf("parsed accounts = %#v", accounts)
	}
}

func TestLoadDoesNotApplyPortDefaults(t *testing.T) {
	path := writeConfig(t, `
admin_listen: ":9443"
`+validTail)

	_, err := config.Load(path)
	if err == nil || err.Error() != "listen is required" {
		t.Fatalf("Load() error = %v, want listen is required", err)
	}

	path = writeConfig(t, `
listen: ":7443"
`+validTail)

	_, err = config.Load(path)
	if err == nil || err.Error() != "admin_listen is required" {
		t.Fatalf("Load() error = %v, want admin_listen is required", err)
	}
}

func TestLoadMissingConfigFile(t *testing.T) {
	_, err := config.Load(filepath.Join(t.TempDir(), "missing.yaml"))
	if err == nil {
		t.Fatal("expected error for missing config file")
	}
}
