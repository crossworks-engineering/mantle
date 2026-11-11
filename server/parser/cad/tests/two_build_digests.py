"""Rebuild the two-build digests in test_dgn_read.py.

They are the document and facts that the converter of v0.600.0 (before the
DGN data reader) gives for the stand-ins of `two_build_doc`, with ezdxf at
the version the test names. The test pins that, with ezdgn 0.3.2, today's
converter gives the same for a 2D file, and for a 3D file the same but for
the rotation of its 3D texts and the count of turns not known. After an
ezdxf bump, rebuild them with the old converter and the new ezdxf:

    git show v0.600.0:server/parser/cad/dgn_read.py > /tmp/dgn_read_v0600.py
    python3 server/parser/cad/tests/two_build_digests.py /tmp/dgn_read_v0600.py

and put the printed lines, and the ezdxf version, in the test.
"""

from __future__ import annotations

import importlib.util
import os
import sys


def main(old: str) -> None:
    spec = importlib.util.spec_from_file_location("dgn_read", old)
    module = importlib.util.module_from_spec(spec)
    sys.modules["dgn_read"] = module  # the test module's `import dgn_read` takes this one
    spec.loader.exec_module(module)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ezdxf  # noqa: PLC0415
    import test_dgn_read as t  # noqa: PLC0415

    d2, i2 = module.build_document(*module._v8_tree(t.two_build_doc(2)))
    d3, i3 = module.build_document(*module._v8_tree(t.two_build_doc(3)))
    print(f'TWO_BUILD_EZDXF = "{ezdxf.__version__}"')
    print(f'MAIN_2D_DOC = "{t.doc_digest(d2)}"')
    print(f'MAIN_2D_FACTS = "{t.facts_digest(i2)}"')
    print(f'MAIN_3D_DOC = "{t.doc_digest(d3)}"')
    print(f'MAIN_3D_DOC_NO_TEXT_TURN = "{t.doc_digest(d3, text_turn=False)}"')
    print(f'MAIN_3D_FACTS_NO_TURN_COUNT = "{t.facts_digest(i3, "text_turn_unknown")}"')


if __name__ == "__main__":
    main(sys.argv[1])
