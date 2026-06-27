package config

import (
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// ZLMConfig only carries the bits needed to talk to the ZLMediaKit REST API.
// The ZLM "app" (stream group) is decided per-call by the front end (mapped
// from the user-supplied "room"), so it is intentionally not part of the
// static configuration.
type ZLMConfig struct {
	APIBase string `yaml:"api_base"`
	Secret  string `yaml:"secret"`
}

type Config struct {
	Listen         string    `yaml:"listen"`
	TLSCert        string    `yaml:"tls_cert"`
	TLSKey         string    `yaml:"tls_key"`
	LogLevel       string    `yaml:"log_level"`
	StaticDir      string    `yaml:"static_dir"`
	AllowedOrigins []string  `yaml:"allowed_origins"`
	// Token is required on business requests when non-empty (entry-check + join).
	Token          string    `yaml:"token"`
	// Admin HTTPS listener and static admin UI (separate from business port).
	AdminListen    string    `yaml:"admin_listen"`
	AdminStaticDir string    `yaml:"admin_static_dir"`
	// Admin accounts: "name1:pass1;name2:pass2"
	AdminAccounts  string    `yaml:"admin_accounts"`
	ZLM            ZLMConfig `yaml:"zlm"`
}

// Load reads configuration from a YAML file, applying defaults.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	c := &Config{}
	if err := yaml.Unmarshal(data, c); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	if c.ZLM.APIBase == "" {
		c.ZLM.APIBase = "http://127.0.0.1:80"
	}
	return c, nil
}

func (c *Config) validate() error {
	c.Listen = strings.TrimSpace(c.Listen)
	c.AdminListen = strings.TrimSpace(c.AdminListen)
	c.TLSCert = strings.TrimSpace(c.TLSCert)
	c.TLSKey = strings.TrimSpace(c.TLSKey)

	if c.Listen == "" {
		return fmt.Errorf("listen is required")
	}
	if c.AdminListen == "" {
		return fmt.Errorf("admin_listen is required")
	}
	if c.Listen == c.AdminListen {
		return fmt.Errorf("listen and admin_listen must be different")
	}
	if c.TLSCert == "" {
		return fmt.Errorf("tls_cert is required (HTTPS only)")
	}
	if c.TLSKey == "" {
		return fmt.Errorf("tls_key is required (HTTPS only)")
	}
	return nil
}
