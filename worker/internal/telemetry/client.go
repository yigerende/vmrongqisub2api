package telemetry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	batchPath           = "/api/event_logging/v2/batch"
	growthbookClientKey = "sdk-zAZezfDKGoZuXXKe"
	evalPath            = "/api/eval/" + growthbookClientKey
)

var allowedHeaders = map[string]bool{
	"user-agent":                  true,
	"x-app":                       true,
	"anthropic-version":           true,
	"x-stainless-lang":            true,
	"x-stainless-os":              true,
	"x-stainless-arch":            true,
	"x-stainless-runtime":         true,
	"x-stainless-runtime-version": true,
	"x-stainless-package-version": true,
	"x-claude-code-session-id":    true,
	"x-service-name":              true,
	"accept-language":             true,
}

type Client struct {
	HTTP          *http.Client
	AnthropicBase *url.URL
	Timeout       time.Duration
}

func (c *Client) PostBatch(ctx context.Context, accessToken string, headers map[string]string, events []Event) error {
	if len(events) == 0 {
		return nil
	}
	return c.postJSON(ctx, batchPath, accessToken, headers, BatchRequest{Events: events})
}

func (c *Client) PostEval(ctx context.Context, accessToken string, headers map[string]string, body map[string]any) error {
	return c.postJSON(ctx, evalPath, accessToken, headers, body)
}

func (c *Client) postJSON(ctx context.Context, path, accessToken string, headers map[string]string, payload any) error {
	if c == nil || c.HTTP == nil || c.AnthropicBase == nil {
		return fmt.Errorf("telemetry client is not configured")
	}
	if strings.TrimSpace(accessToken) == "" {
		return fmt.Errorf("access token is required")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := c.AnthropicBase.ResolveReference(&url.URL{Path: path})
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	for key, value := range headers {
		canon := strings.ToLower(strings.TrimSpace(key))
		if !allowedHeaders[canon] {
			continue
		}
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		req.Header.Set(canon, value)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 400 {
		kind := jsonErrorType(raw)
		shape := jsonTopKeys(raw)
		if kind != "" {
			return fmt.Errorf("%s status %d type=%s keys=%s", path, resp.StatusCode, kind, shape)
		}
		return fmt.Errorf("%s status %d keys=%s", path, resp.StatusCode, shape)
	}
	return nil
}

func jsonTopKeys(raw []byte) string {
	if len(raw) == 0 {
		return "empty"
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		return "nonjson"
	}
	keys := make([]string, 0, len(doc))
	for key := range doc {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}

func jsonErrorType(raw []byte) string {
	var doc map[string]json.RawMessage
	if json.Unmarshal(raw, &doc) != nil {
		return ""
	}
	if inner, ok := doc["error"]; ok {
		var obj map[string]json.RawMessage
		if json.Unmarshal(inner, &obj) == nil {
			var innerType string
			if rawType, ok := obj["type"]; ok && json.Unmarshal(rawType, &innerType) == nil && innerType != "" {
				return innerType
			}
		}
	}
	var top string
	if rawType, ok := doc["type"]; ok && json.Unmarshal(rawType, &top) == nil {
		return top
	}
	return ""
}

// ClassifyBatchErr maps a PostBatch error to a log-safe class.
// Never returns the raw error string (it can contain proxy userinfo).
func ClassifyBatchErr(err error) (class string, status int) {
	if err == nil {
		return "ok", 0
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout", 0
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout", 0
	}
	msg := err.Error()
	if _, n, ok := cutStatus(msg); ok {
		return "status", n
	}
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline") {
		return "timeout", 0
	}
	if strings.Contains(lower, "proxy") || strings.Contains(lower, "socks") {
		return "socks", 0
	}
	return "net", 0
}

func cutKeys(msg string) (prefix string, keys string, ok bool) {
	const mark = "keys="
	i := strings.LastIndex(msg, mark)
	if i < 0 {
		return "", "", false
	}
	keys = strings.TrimSpace(msg[i+len(mark):])
	if keys == "" || strings.ContainsAny(keys, " \t\n") {
		return "", "", false
	}
	return msg[:i], keys, true
}

func cutType(msg string) (prefix string, kind string, ok bool) {
	const mark = "type="
	i := strings.LastIndex(msg, mark)
	if i < 0 {
		return "", "", false
	}
	fields := strings.Fields(msg[i+len(mark):])
	if len(fields) == 0 {
		return "", "", false
	}
	kind = fields[0]
	if kind == "" {
		return "", "", false
	}
	return msg[:i], kind, true
}

func cutStatus(msg string) (prefix string, status int, ok bool) {
	const mark = "status "
	i := strings.LastIndex(msg, mark)
	if i < 0 {
		return "", 0, false
	}
	n, err := fmt.Sscanf(msg[i+len(mark):], "%d", &status)
	if err != nil || n != 1 || status < 100 || status > 599 {
		return "", 0, false
	}
	return msg[:i], status, true
}
