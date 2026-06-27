package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog/log"

	"zlm_meet/backend/pkg/adminauth"
	"zlm_meet/backend/pkg/config"
	"zlm_meet/backend/pkg/logger"
	"zlm_meet/backend/pkg/server"
	"zlm_meet/backend/pkg/signaling"
	"zlm_meet/backend/pkg/staticdir"
	"zlm_meet/backend/pkg/zlm"
)

func main() {
	logger.Init()

	cfgPath := flag.String("config", "config.yaml", "path to YAML config file")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatal().Err(err).Msg("load config")
	}
	logger.SetLevel(cfg.LogLevel)

	staticdir.WarnIfMisconfigured("static_dir", cfg.StaticDir, "index.html")
	staticdir.WarnIfMisconfigured("admin_static_dir", cfg.AdminStaticDir, "index.html")

	zlmClient := zlm.New(cfg.ZLM)
	hub := signaling.NewHub(zlmClient, cfg.Token)
	handler := server.NewBusiness(cfg, hub)

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Info().Msg("listening:")
	log.Info().Str("port", cfg.Listen).Str("scheme", "HTTPS").Msg("business")
	log.Info().Str("port", cfg.AdminListen).Str("scheme", "HTTPS").Msg("admin")
	log.Info().Str("api_base", cfg.ZLM.APIBase).Msg("zlm api")

	businessLn, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		log.Fatal().Err(err).Str("port", cfg.Listen).Msg("business listen")
	}
	adminLn, err := net.Listen("tcp", cfg.AdminListen)
	if err != nil {
		_ = businessLn.Close()
		log.Fatal().Err(err).Str("port", cfg.AdminListen).Msg("admin listen")
	}

	go serveTLS("business", srv, businessLn, cfg.TLSCert, cfg.TLSKey)

	// Admin HTTPS server (always started on admin_listen).
	adminAuth := adminauth.New(adminauth.ParseAccounts(cfg.AdminAccounts))
	adminHandler := server.NewAdmin(cfg, hub, adminAuth)
	adminSrv := &http.Server{
		Handler:           adminHandler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go serveTLS("admin", adminSrv, adminLn, cfg.TLSCert, cfg.TLSKey)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh
	log.Info().Msg("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = adminSrv.Shutdown(ctx)
	_ = srv.Shutdown(ctx)
}

func serveTLS(name string, srv *http.Server, ln net.Listener, cert, key string) {
	if err := srv.ServeTLS(ln, cert, key); err != nil && err != http.ErrServerClosed {
		log.Fatal().Err(fmt.Errorf("%s serve: %w", name, err)).Msg("listen")
	}
}
