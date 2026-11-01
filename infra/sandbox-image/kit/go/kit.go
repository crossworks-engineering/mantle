// Package kit exists only so `go mod download` fetches the sandbox image's Go
// kit into the module cache (and `go mod tidy` keeps go.sum complete). It is
// never built into anything.
package kit

import (
	_ "github.com/go-chi/chi/v5"
	_ "github.com/jackc/pgx/v5"
	_ "github.com/spf13/cobra"
	_ "github.com/stretchr/testify/assert"
	_ "github.com/stretchr/testify/require"
	_ "github.com/xuri/excelize/v2"
	_ "gopkg.in/yaml.v3"
	_ "modernc.org/sqlite"
)
