package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type ZLMConfig struct {
	APIBase string `yaml:"api_base"`
	Secret  string `yaml:"secret"`
	App     string `yaml:"app"`
	Vhost   string `yaml:"vhost"`
}

// IceServer mirrors the browser RTCIceServer dictionary so the front end can
// consume it directly.
type IceServer struct {
	URLs       []string `yaml:"urls" json:"urls"`
	Username   string   `yaml:"username,omitempty" json:"username,omitempty"`
	Credential string   `yaml:"credential,omitempty" json:"credential,omitempty"`
}

// WebRTCConfig holds runtime knobs the front end fetches at startup. Keeping
// these on the server avoids hard-coding STUN/TURN inside the static JS so the
// same build can run on LAN and on the public internet.
type WebRTCConfig struct {
	IceServers []IceServer `yaml:"ice_servers" json:"iceServers"`
}

type Config struct {
	Listen         string       `yaml:"listen"`
	TLSCert        string       `yaml:"tls_cert"`
	TLSKey         string       `yaml:"tls_key"`
	StaticDir      string       `yaml:"static_dir"`
	AllowedOrigins []string     `yaml:"allowed_origins"`
	ZLM            ZLMConfig    `yaml:"zlm"`
	WebRTC         WebRTCConfig `yaml:"webrtc"`
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
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	if c.ZLM.APIBase == "" {
		c.ZLM.APIBase = "http://127.0.0.1:80"
	}
	if c.ZLM.App == "" {
		c.ZLM.App = "meeting"
	}
	if c.ZLM.Vhost == "" {
		c.ZLM.Vhost = "__defaultVhost__"
	}
	if c.WebRTC.IceServers == nil {
		// Marshalling nil slice yields JSON `null`; emit an explicit empty
		// array so the front end can skip null-checks.
		c.WebRTC.IceServers = []IceServer{}
	}
	return c, nil
}
