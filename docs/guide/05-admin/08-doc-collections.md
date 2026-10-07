# Add documentation collections

Index a folder of Markdown files so the assistant can answer from it with citations, and so people can read it under **Docs** in Jackdaw.

A collection is one folder of `.md` files. Nothing is indexed until you switch a collection on. Files stay the source: the **Docs** viewer is read-only, and edits happen in the files.

Mantle ships four collections, all off. The two you are most likely to want are **User Guide** (this guide) and **System docs** (the developer documentation).

## Switch a collection on

1. Open **Docs** in the menu.
2. Switch on the collection.

It is searchable straight away. Switching it off removes its docs from the brain and asks first. The files on disk stay.

## Add your own collection

1. Open **Docs** and click **New collection**.
2. Fill in:
   - **Label**: the name people see, for example `Work handbook`.
   - **Key**: a short unique slug, for example `handbook`.
   - **Root path**: the folder to index. A relative path (for example `guide`) reads from the docs shipped with Mantle. An absolute path reads that folder.
   - **Brain depth**: see below.
3. Click **Create collection**.

On a Docker install, an absolute path must be a folder the Mantle containers can see. A folder that exists only on the host is not visible to them.

A new collection's folder cannot sit inside, or contain, another collection's folder. **System docs** is the one exception.

## Brain depth

| Depth | What it does | Use it for |
|---|---|---|
| **Retrieval-only** | The assistant can find and cite the text. Nothing is added to your facts or entities. | Reference material, manuals, other people's docs. |
| **Full extraction** | The docs feed facts and entities like any other content. | Your own notes kept as Markdown. |

## Keep it current

Mantle watches the enabled folders and re-reads only the files that changed. To force a full refresh, switch the collection off and on.

## Check it worked

Ask the assistant something the docs answer, for example "What do the docs say about backups?". The answer cites the file and section.

## Next

- [Docs screen help](../06-help/docs.md)
- [Add knowledge and ask for it](../02-first-steps/03-add-knowledge.md)
