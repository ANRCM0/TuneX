package panel

import (
	"encoding/json"
	"fmt"
	"time"
)

// licenseDocument is the JSON the agent unmarshals after Fernet-decrypting the
// register ack's `license` field (upstream key2). Field names and the
// site_url / expired_at checks are from reports/AGENT_ANALYSIS.md §4.3–4.4.
//
// expired_at is unix seconds. The ack's `now` is also unix seconds
// (`Math.floor(Date.now()/1000)`). Upstream compares them as float64 and
// treats `now <= expired_at` as still valid (`jbe`). A failed check only
// logs; it does not stop the process.
type licenseDocument struct {
	SiteURL   string `json:"site_url"`
	Type      string `json:"type"`
	ExpiredAt int64  `json:"expired_at"`
}

// licenseReport is the result of that check.
type licenseReport struct {
	Doc     licenseDocument
	SiteOK  bool
	Expired bool
}

// inspectLicense unmarshals a decrypted license and applies the upstream
// comparisons. now is the ack's `now` when present, otherwise local unix time.
func inspectLicense(plain []byte, ackSite string, now float64) (licenseReport, error) {
	var doc licenseDocument
	if err := json.Unmarshal(plain, &doc); err != nil {
		return licenseReport{}, fmt.Errorf("license json: %w", err)
	}
	return licenseReport{
		Doc:     doc,
		SiteOK:  doc.SiteURL == ackSite,
		Expired: now > float64(doc.ExpiredAt),
	}, nil
}

// ackNow prefers the register ack's `now` (server time). Missing or
// non-numeric values fall back to the local clock, matching the upstream
// branch at 0x1037b40.
func ackNow(ack map[string]any) float64 {
	switch v := ack["now"].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		if f, err := v.Float64(); err == nil {
			return f
		}
	}
	return float64(time.Now().Unix())
}

// formatLicenseExpiry is the string interpolated into
// "License is expired at %s, please renew your license".
func formatLicenseExpiry(expiredAt int64) string {
	return time.Unix(expiredAt, 0).UTC().Format(time.RFC3339)
}
