# Weft Deploy Site

Publish a directory your workflow just built to a repository on
[Weft](https://weft.sh), where a committed
[`.weft/site.yml`](https://weft.sh/docs/static-sites/) serves it as a
static site. One step after the build; no upload endpoint, no second
vendor holding a token on your code.

```yaml
- run: npm run build
- uses: weftsh/deploy-site@v1
  with:
    repository: acme/widget          # the repository on Weft, org/repo
    token: ${{ secrets.WEFT_TOKEN }}  # repo:write
```

And once, on the repository's default branch on Weft, `.weft/site.yml`:

```yaml
publish: dist
branch: weft-site
```

## How it works

Weft has no upload route. A repository changes only by commits, so the
action makes one: it walks the built directory, asks the branch for the
tree it already holds, and commits exactly the difference through the
[commit API](https://weft.sh/docs/api/), with `expected_parent` pinned to
the tip it read. A file whose bytes are unchanged (same git blob id) is
never sent; a file that is gone locally is deleted from the tree. A
second deploy of the same build makes no commit at all.

The push that lands arms Weft's publish job, and the site is the tree of
`path` at the new tip. The action then reads `GET …/site` and prints the
address, or a notice that the deployment serves no sites domain yet.

A deploy larger than one request (see the limits below) is committed in
chunks to `<branch>-staging`, and `branch` is moved to the finished
commit in one step, so the publish job never reads a half-written tree.
One more commit then lands on `branch`, re-putting the smallest file
with the bytes it already has: a ref move alone does not arm the publish
job, and a commit does. The tree is identical either side of it.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `token` | | A Weft token with `repo:write` on the repository. Sent as a header, never in a URL, never in a log. |
| `repository` | | The repository on Weft, as `org/repo`. It must be a native repository: a mirror is read-only and answers `403`. |
| `directory` | `dist` | The built directory, relative to the workspace. |
| `path` | `dist` | Where in the tree the files land. `publish:` in `.weft/site.yml` must name the same directory; Weft cannot publish the root of a tree. |
| `branch` | `weft-site` | The branch that receives the deploy. `branch:` in `.weft/site.yml` must name it; the config file itself is read from the default branch. |
| `api-url` | `https://api.weft.sh` | The Weft deployment. |
| `message` | `Deploy <short sha> from <repository>` | The commit message. |
| `chunk-operations` | `5000` | The most file operations per request. Weft refuses more than 10000. |
| `chunk-bytes` | `33554432` | The most bytes of content per request, as sent. Weft refuses a request body over 64 MB. |

## Outputs

| Output | Meaning |
|---|---|
| `commit` | The commit `branch` points at when the deploy is done. |
| `url` | The site's address, or empty when the deployment has no public sites domain yet. |
| `changed` | Files put or deleted. `0` means the branch already held the directory. |

## What fails, and why

The step fails, naming the path or the reason, before anything is sent:

- **a symlink** anywhere under `directory`. The commit API writes bytes,
  never a link, and a site never follows one, so it would either be
  silently replaced by its target or silently dropped;
- **an executable file**. The API only ever writes mode `100644`, so the
  bit would be lost without a word. Clear it in the build, or accept
  that a site serves bytes and has no use for it;
- **a `.git` entry**, which the server rejects as a path;
- **an empty or missing directory**. Publishing nothing is never what a
  build meant;
- **a single file larger than one request may carry**, about 63 MB as
  sent. Binary files travel base64-encoded, so the limit on disk is
  about 47 MB;
- **`path` that is empty, `/`, or has a `.`, `..` or `.git` segment**.
  `.weft/site.yml` refuses to publish the root, so a deploy there could
  never be served.

The step also fails when Weft never answers: the message names the
request and the reason the transport gave (`GET /branches got no
answer: fetch failed: connect ECONNREFUSED …`), which is what a wrong
`api-url`, a deployment that is down, or a runner with no route out
looks like.

The step also fails when Weft refuses:

- `401`/`404`: the token cannot see the repository, or it does not exist;
- `403`: the repository is a mirror, or `branch` is protected (a
  protected branch moves only through the land queue);
- `402`: the organization is over its storage allowance;
- `409` **twice**: `branch` moved during the deploy. The first `409` is
  recomputed against the new tip and retried once; a second one means
  something else is writing the branch continuously. When the staging
  branch of a chunked deploy moves under the action, it stops rather
  than resetting over another deploy's work.

The step succeeds with a **warning** when the deploy landed but will not
be served, and says what to change:

- no `.weft/site.yml` on the default branch;
- the config is refused (its line and reason are printed);
- the config publishes a different branch or a different directory than
  this deploy wrote.

## Limits

- **64 MB per request, 10000 operations per request.** Both are Weft's.
  A deploy that needs more is chunked and staged as described above; the
  defaults leave headroom under both.
- **No executable bit, no symlinks.** The commit API writes plain files
  only, and the action refuses rather than approximating.
- **A URL only appears once the deployment serves a sites domain.**
  `url` is empty until then, and the job says so in a notice. The
  address is Weft's to assign; read it from the output rather than
  assembling it.
- **The site is public.** A published site is served to anybody with its
  address even when the repository is private.

## Getting a token

Mint a `repo:write` token for CI on the repository's settings page on
Weft and store it as a repository secret. See
[Authentication](https://weft.sh/docs/authentication/).

## License

MIT.
