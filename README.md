# Text to Commit History

Draws text on your GitHub contribution graph. It renders what you type into the 7 by 52 grid of squares, then writes backdated empty commits into a fresh repository, one batch per square, using git's willingness to accept any date you hand it.

The text is scaled to the largest size that fits: seven rows tall including descenders, and no wider than the weeks you have left.

<img width="913" height="207" alt="image" src="https://github.com/user-attachments/assets/1b81b21a-84a1-4540-bc11-fc5ec83ea865" />


That is "SIX SEVEN" on a real profile.

## Requirements

- [Bun](https://bun.sh)
- git 2.28 or newer
- A GitHub account and a new, empty repository to hold the commits

## Usage

1. Create the empty repository on GitHub. Do not add a README, the push needs it bare.
2. Install dependencies:
   ```
   bun install
   ```
3. Run the tool and answer the questions:
   ```
   bun start
   ```
   ```
   GitHub server (change this only for GitHub Enterprise) [https://github.com/]:
   Your GitHub username: TheArmagan

   Reading your contribution calendar...
   Your busiest day in the last year has 98 commits.

   Text to draw on your calendar (blank draws a cat): Hi

     #...##..
     #...##..
     #...##.#
     ######.#
     #...##.#
     #...##.#
     #...##.#

   The drawing is 8 weeks wide, out of the 52 on your calendar.
   Move it right by how many weeks [0]: 2
   Draw darker than your busiest day? (y/n) [n]:
   Name of the new (empty!) repository these commits go to: hello-graph
   ```
   Two files come out, and they belong together: `text_to_commit_history.fi` holds the commits, and a script feeds that stream to git.
4. Run the script from a directory that is not itself a git repository. It finishes in a few seconds.

   Linux and macOS:
   ```
   ./text_to_commit_history.sh
   ```
   Windows:
   ```
   powershell -ExecutionPolicy Bypass -File text_to_commit_history.ps1
   ```
5. Give GitHub a day or so to redraw your graph.

## Options

```
bun start -- --shell=bash                              # or powershell, overriding your platform
bun start -- --branch=master                           # branch to push, default main
bun start -- --name="Your Name" --email=you@example.com  # commit author, default from git config
bun start -- --ssh                                     # push over SSH instead of HTTPS
```

## Getting the squares to actually appear

GitHub counts a commit towards your graph only if both of these hold:

- The author email belongs to your account. The tool reads it from `git config` and prints what it baked in, so check that line before you push.
- The commit sits on the repository's default branch. That is `main` for a new GitHub repository, which is what the script pushes.

The push uses HTTPS, so git authenticates through your credential helper. If you have never set one up, `gh auth login` handles it, or `gh auth setup-git` when the CLI is already logged in. Reach for `--ssh` only if you have an SSH key on GitHub, otherwise the push stops at `Permission denied (publickey)`.

## Speed

The commits go in through `git fast-import` in a single pass. Calling `git commit` once per commit instead costs roughly 50 ms each, so the 36,876 commits of a full width drawing take about half an hour that way. fast-import writes the same history in 0.6 seconds.

Commit counts are also trimmed to what each shade needs. GitHub shades a square by comparing it against your busiest day of the year in four bands, so the palest squares get a single commit rather than a quarter of your busiest day. The graph looks identical and a quarter to a third of the commits stop being written at all.

## Layout

- `src/index.ts` asks the questions, reads your contribution calendar, and writes the commit stream and its runner script.
- `src/textToMatrix.ts` turns your text into the 7 row matrix, rendering `Arial.ttf` through [opentype.js](https://github.com/opentypejs/opentype.js) and a small monochrome rasterizer.

## Removal

Delete the repository you created, and wait for the graph to catch up.
