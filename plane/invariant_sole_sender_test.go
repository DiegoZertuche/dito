package plane_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The CI invariant scan (ticket #25 AC 1, ADR-0006): the executor package
// is the sole caller of the rail's MESSAGE-egress APIs, and the one other
// reference the scan permits is named below with its argument
// (peerRequestException). Runs in both CI lanes via `go test ./...` — a
// send call creeping into any other plane package fails the build, not a
// review.
//
// The scan walks every non-test Go file in the module and flags any call
// or method-value reference to a send API selector outside
// plane/executor, that one exception apart. AST-based, so comments and
// strings can never false-positive, and a new file is covered the moment
// it exists.

// sendSelectors are whatsmeow's message-egress surface: anything that can
// put a message (or its revocation/edit) on the rail, plus the escape
// hatch exposing the client's internals (Codex round 1: the list must
// cover every alternate send API and the dangerous backdoor to them, or
// a new outbound path could bypass the executor without failing here).
//
// `PairPhone` IS DELIBERATELY NOT ONE OF THEM (ticket #222). It asks the
// SERVER for a linking code and returns eight characters: no stanza in any
// chat, no counterparty, nothing anybody said. What it can do wrong is leak a
// credential, which is why the row that carries it withholds `detail` from
// every role but the plane's — a different wall, argued where the call is
// made (plane/pairing's PhonePairer).
var sendSelectors = map[string]bool{
	"SendMessage":             true,
	"SendPeerMessage":         true,
	"SendFBMessage":           true,
	"RevokeMessage":           true,
	"BuildRevoke":             true,
	"BuildEdit":               true,
	"DangerousInternalClient": true,
}

// peerRequestException is the ONE reference the scan permits outside the
// executor, named by file AND selector rather than by package: the plane's
// on-demand history request (tickets #216, #222).
//
// WHY IT DOES NOT WEAKEN THE WALL. ADR-0006 reserves the rail's send APIs to
// the executor so that nothing reaches a customer without a recorded tap. A
// peer message addresses the account's OWN primary device, carries the fixed
// on-demand-history proto whatsmeow's own builder composes, appears in no
// chat and reaches no counterparty — it is a protocol request, not a post.
// Why the request has to be made from inside this binary at all is argued in
// plane/historyspike's package header.
//
// THE NINETY-DAY FILL FITS INSIDE IT WITHOUT WIDENING IT (ticket #222), and
// the reason is the shape of the scan rather than a favour: `plane/fill` sends
// its pages through `historyspike.Request`, so it is a CALLER of the named
// file rather than a second path to a send API. One path and one selector is
// the whole exception, and a fill that reached `SendPeerMessage` itself would
// fail below.
//
// Scoped as narrowly as the scan can express it — one path, one selector —
// and guarded against rot from both sides: a send API in any other file
// fails below, and an exception that references nothing fails too, so it
// cannot outlive the request it exists for.
var peerRequestException = struct {
	file     string
	selector string
}{
	file:     filepath.Join("historyspike", "request.go"),
	selector: "SendPeerMessage",
}

func TestExecutorIsTheSoleCallerOfRailSendAPIs(t *testing.T) {
	root, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	var violations []string
	executorSeen := false
	exceptionSeen := false

	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		inExecutor := strings.HasPrefix(rel, "executor"+string(filepath.Separator))

		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok || !sendSelectors[sel.Sel.Name] {
				return true
			}
			if inExecutor {
				executorSeen = true
				return true
			}
			if rel == peerRequestException.file && sel.Sel.Name == peerRequestException.selector {
				exceptionSeen = true
				return true
			}
			pos := fset.Position(sel.Pos())
			violations = append(violations, pos.String()+" references "+sel.Sel.Name)
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, v := range violations {
		t.Errorf("send API outside plane/executor (ADR-0006: the executor is the sole caller): %s", v)
	}
	// The positive half keeps the scan honest: if the send surface is ever
	// renamed, the selector list must move with it rather than rotting
	// into a scan of nothing.
	if !executorSeen {
		t.Error("the scan found no send API reference inside plane/executor — the selector list has rotted")
	}
	if !exceptionSeen {
		t.Errorf("the named exception (%s → %s) references nothing — delete the exception, the file it names is gone",
			peerRequestException.file, peerRequestException.selector)
	}
}
