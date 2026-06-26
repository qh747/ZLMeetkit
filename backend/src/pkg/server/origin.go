package server

import (
	"net/http"
	"net/url"
)

func buildOriginChecker(allowed []string) func(r *http.Request) bool {
	if len(allowed) == 0 {
		return func(_ *http.Request) bool { return true }
	}
	allowSet := make(map[string]struct{}, len(allowed))
	for _, o := range allowed {
		allowSet[o] = struct{}{}
	}
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		_, ok := allowSet[u.Scheme+"://"+u.Host]
		return ok
	}
}
