import io
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

raw = open("src/client/index.tsx", "rb").read().decode("utf-8")
lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
print("total lines:", len(lines))

NEEDLES = [
    "const [ideas, setIdeas]",
    "const [ideaRefreshKey",
    "const loadIdeas = useCallback",
    "const ideaCardItems",
    "const unfiledIdeas",
    "const refreshIdeas",
    "const saveFolder",
    "const deleteFolder",
    "const fileIdeaInto",
    "const unfileIdeaFrom",
    "const mergeFolderInto",
    "const folderForm",
    "view === 'ideas'",
    "view === 'ideas' && (",
    "ideaForm !== null",
    "selectedCluster !== null",
    "mode === 'idea_association'",
    "mode === 'idea_brainstorm'",
    "startAISessionRef.current = startAISession",
    "const knowledge = useKnowledge({",
    "IdeaCardGrid",
    "idea_kind",
]
for n in NEEDLES:
    hits = [i + 1 for i, l in enumerate(lines) if n in l]
    print(f"{n!r:44} {hits}")
