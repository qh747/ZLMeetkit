package adminauth

import "strings"

// ParseAccounts parses "user1:pass1;user2:pass2" into a username→password map.
// Password may contain colons; only the first colon in each segment separates user and pass.
func ParseAccounts(raw string) map[string]string {
	accounts := make(map[string]string)
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return accounts
	}
	for _, part := range strings.Split(raw, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		idx := strings.Index(part, ":")
		if idx <= 0 {
			continue
		}
		user := strings.TrimSpace(part[:idx])
		if user == "" {
			continue
		}
		accounts[user] = part[idx+1:]
	}
	return accounts
}
