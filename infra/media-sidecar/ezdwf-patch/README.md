# ezdwf lazy-read patch (temporary vendored fix)

Stock ezdwf 0.0.3 materializes an entire DWF as one giant Python dict tree
inside `read()` before the dataclass layer consumes it. On a real 630 KB /
9-sheet plot set that transient tree peaks at ~1.27 GB RSS — an OOM under the
default 1 GiB media container limit. With this patch the same file peaks at
541 MB and the output is identical (upstream test suite passes; 300-dpi
`save_plot` renders are byte-identical on all 9 sheets).

These three files are copies of upstream files (MIT licensed, © the ezdwf
authors, https://github.com/monozukuri-ai/ezdwf) with the lazy-read change
applied on top of upstream commit `d134278004f527f3062bf49d7db7a8df3887fedc`:

| file          | overwrites                        |
| ------------- | --------------------------------- |
| `lib.rs`      | `crates/ezdwf-python/src/lib.rs`  |
| `document.py` | `src/ezdwf/document.py`           |
| `raw.py`      | `src/ezdwf/raw.py`                |

The `ezdwf-build` stage in the root Dockerfile downloads that exact upstream
commit, copies these files over it, and builds the wheel the media image
installs. The upstream sha and these files move together — bump neither
without the other.

Remove this directory (and the `ezdwf-build` Dockerfile stage) once the
upstream PR is merged and released; then pin the released version in the
media stage instead.
