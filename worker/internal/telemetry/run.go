package telemetry

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/config"
	"github.com/dofastted/kin-gateway/worker/internal/credential"
)

const (
	sessionTTL         = 10 * time.Minute
	eventBatchInterval = 10 * time.Second
	growthbookInterval = 6 * time.Hour
	tickInterval       = time.Second
	touchName          = "telemetry.touch"
)

type Deps struct {
	HTTP       *Client
	Store      *credential.Store
	Now        func() time.Time
	Sleep      func(ctx context.Context, d time.Duration) bool
	RetryWait  time.Duration
	TouchPath  string
	ConfigPath string
	LoadConfig func(path string) (config.TelemetryConfig, error)
}

func defaultSleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func TouchPath(cfg config.Config) string {
	if strings.TrimSpace(cfg.ConfigPath) == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(cfg.ConfigPath), touchName)
}

func WriteTouch(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	return os.WriteFile(path, []byte(time.Now().UTC().Format(time.RFC3339Nano)+"\n"), 0o600)
}

func lastActivity(path string, fallback time.Time) time.Time {
	if strings.TrimSpace(path) == "" {
		return fallback
	}
	info, err := os.Stat(path)
	if err != nil {
		return fallback
	}
	return info.ModTime()
}

// Run mirrors cc-bridge telemetry_loop:
// /v1 (or worker start) activates a 10-minute session.
// Every 10s: event_logging/v2/batch tengu_api_success.
// Every 6h (first immediate): GrowthBook /api/eval.
// worker.json telemetry is re-read when the file mtime moves, so identity,
// betas, headers, env, and enabled flip without bouncing the process.
// A disabled config with no file still returns immediately.
func Run(ctx context.Context, cfg config.Config, deps Deps) error {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.Sleep == nil {
		deps.Sleep = defaultSleep
	}
	if deps.TouchPath == "" {
		deps.TouchPath = TouchPath(cfg)
	}
	tel := cfg.Telemetry
	configPath := strings.TrimSpace(deps.ConfigPath)
	if configPath == "" {
		configPath = strings.TrimSpace(cfg.ConfigPath)
	}
	loadTelemetry := deps.LoadConfig
	if loadTelemetry == nil {
		loadTelemetry = config.LoadTelemetry
	}
	var seen time.Time
	var loadedKey string
	refresh := func() {
		if configPath == "" {
			return
		}
		info, err := os.Stat(configPath)
		if err != nil {
			return
		}
		if !seen.IsZero() && !info.ModTime().After(seen) {
			return
		}
		next, err := loadTelemetry(configPath)
		if err != nil {
			log.Printf("telemetry sidecar: reload skipped")
			seen = info.ModTime()
			return
		}
		tel = next
		seen = info.ModTime()
	}
	refresh()
	if !tel.Enabled && configPath == "" {
		return nil
	}
	started := deps.Now()
	var lastBatch time.Time
	var lastGrowthbook time.Time
	sentInit := false
	batchOK := true
	evalOK := true

	for {
		if ctx.Err() != nil {
			return nil
		}
		refresh()
		now := deps.Now()
		if !tel.Enabled {
			loadedKey = ""
			sentInit = false
			if !deps.Sleep(ctx, tickInterval) {
				return nil
			}
			continue
		}
		if key := telemetryKey(tel); key != loadedKey {
			sentInit = false
			loadedKey = key
		}
		activity := lastActivity(deps.TouchPath, started)
		if now.Sub(activity) > sessionTTL {
			if !deps.Sleep(ctx, tickInterval) {
				return nil
			}
			continue
		}
		identity := overlayIdentity(tel.Identity, credOrEmpty(deps))
		if strings.TrimSpace(identity.Betas) == "" {
			identity.Betas = strings.TrimSpace(tel.Betas)
		}
		token := accessToken(deps)
		if token == "" {
			if !deps.Sleep(ctx, tickInterval) {
				return nil
			}
			continue
		}
		live := cfg
		live.Telemetry = tel

		if !sentInit {
			ev := InitEvent(identity, now)
			if err := postBatch(ctx, deps, live, token, ev); err != nil {
				if stopOn4xx(err) {
					return nil
				}
			} else {
				sentInit = true
			}
		}

		if batchOK && (lastBatch.IsZero() || now.Sub(lastBatch) >= eventBatchInterval) {
			uptime := now.Sub(started).Seconds()
			ev := SuccessEvent(identity, now, uptime, "")
			if err := postBatch(ctx, deps, live, token, ev); err != nil {
				if stopOn4xx(err) {
					batchOK = false
				}
			} else {
				lastBatch = now
			}
		}

		if evalOK && (lastGrowthbook.IsZero() || now.Sub(lastGrowthbook) >= growthbookInterval) {
			if err := postEval(ctx, deps, live, token, GrowthbookEval(identity)); err != nil {
				if stopOn4xx(err) {
					evalOK = false
				}
			} else {
				lastGrowthbook = now
			}
		}

		if !deps.Sleep(ctx, tickInterval) {
			return nil
		}
	}
}

func telemetryKey(tel config.TelemetryConfig) string {
	id := tel.Identity
	return strings.Join([]string{
		id.DeviceID,
		id.UserID,
		id.SessionID,
		id.CLIVersion,
		id.Source,
		tel.Betas,
		id.Betas,
	}, "|")
}

func credOrEmpty(deps Deps) credential.Credential {
	if deps.Store == nil {
		return credential.Credential{}
	}
	cred, err := deps.Store.Status()
	if err != nil {
		return credential.Credential{}
	}
	return cred
}

func accessToken(deps Deps) string {
	if deps.Store == nil {
		return ""
	}
	cred, err := deps.Store.Status()
	if err != nil || !cred.Valid() || cred.IsAPIKey() || cred.NeedsRefresh(deps.Now(), time.Minute) {
		return ""
	}
	return cred.AccessToken
}

func postBatch(ctx context.Context, deps Deps, cfg config.Config, token string, ev Event) error {
	if deps.HTTP == nil {
		return nil
	}
	err := deps.HTTP.PostBatch(ctx, token, cfg.Telemetry.Headers, []Event{ev})
	if err != nil {
		class, status := ClassifyBatchErr(err)
		log.Printf("telemetry sidecar: batch failed class=%s status=%d", class, status)
	}
	return err
}

func postEval(ctx context.Context, deps Deps, cfg config.Config, token string, body map[string]any) error {
	if deps.HTTP == nil {
		return nil
	}
	err := deps.HTTP.PostEval(ctx, token, cfg.Telemetry.Headers, body)
	if err != nil {
		class, status := ClassifyBatchErr(err)
		log.Printf("telemetry sidecar: eval failed class=%s status=%d", class, status)
	}
	return err
}

func stopOn4xx(err error) bool {
	class, status := ClassifyBatchErr(err)
	return class == "status" && status >= 400 && status < 500
}

func overlayIdentity(id config.TelemetryIdentity, cred credential.Credential) config.TelemetryIdentity {
	if strings.TrimSpace(cred.Email) != "" {
		id.Email = cred.Email
	}
	if strings.TrimSpace(cred.AccountUUID) != "" {
		id.AccountUUID = cred.AccountUUID
	}
	if strings.TrimSpace(cred.OrgUUID) != "" {
		id.OrgUUID = cred.OrgUUID
	}
	if strings.TrimSpace(id.Platform) == "" {
		id.Platform = defaultPlatform
	}
	if strings.TrimSpace(id.Entrypoint) == "" {
		id.Entrypoint = "cli"
	}
	return id
}
