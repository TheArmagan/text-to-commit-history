#!/usr/bin/env bun

import { chmod } from 'node:fs/promises';

import { getArialFontMatrix } from './textToMatrix.ts';

const GITHUB_BASE_URL = 'https://github.com/';
const DEFAULT_BRANCH = 'main';

/** Columns on the contribution calendar, one week each. */
const CALENDAR_WEEKS = 52;
const COMMIT_MESSAGE = 'text_to_commit_history';
const STREAM_FILENAME = 'text_to_commit_history.fi';

/** Which shell the generated runner script is written for. */
type Shell = 'bash' | 'powershell';

const RUNNER_FILENAME: Record<Shell, string> = {
  bash: 'text_to_commit_history.sh',
  powershell: 'text_to_commit_history.ps1',
};

interface Author {
  name: string;
  email: string;
}

const TITLE = `
 _____         _     _____        ____                          _ _     _   _ _     _
|_   _|____  _| |_  |_   _|__    / ___|___  _ __ ___  _ __ ___ (_) |_  | | | (_)___| |_ ___  _ __ _   _
  | |/ _ \\ \\/ / __|   | |/ _ \\  | |   / _ \\| '_ \` _ \\| '_ \` _ \\| | __| | |_| | / __| __/ _ \\| '__| | | |
  | |  __/>  <| |_    | | (_) | | |__| (_) | | | | | | | | | | | | |_  |  _  | \\__ \\ || (_) | |  | |_| |
  |_|\\___/_/\\_\\\\__|   |_|\\___/   \\____\\___/|_| |_| |_|_| |_| |_|_|\\__| |_| |_|_|___/\\__\\___/|_|   \\__, |
                                                                                                  |___/

`;

const KITTY: number[][] = [
  [0, 0, 0, 4, 0, 0, 0, 0, 4, 0, 0, 0],
  [0, 0, 4, 2, 4, 4, 4, 4, 2, 4, 0, 0],
  [0, 0, 4, 2, 2, 2, 2, 2, 2, 4, 0, 0],
  [2, 2, 4, 2, 4, 2, 2, 4, 2, 4, 2, 2],
  [0, 0, 4, 2, 2, 3, 3, 2, 2, 4, 0, 0],
  [2, 2, 4, 2, 2, 2, 2, 2, 2, 4, 2, 2],
  [0, 0, 0, 3, 4, 4, 4, 4, 3, 0, 0, 0],
];

/** Retrieves the GitHub commit calendar data for a username. */
async function retrieveContributionsCalendar(username: string, baseUrl: string): Promise<string> {
  const url = `${baseUrl}users/${username}/contributions`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.log(`Could not reach ${url}`);
    console.log(error);
    process.exit(1);
  }

  if (!response.ok) {
    console.log(`Could not read ${url}`);
    console.log(`The server answered ${response.status} ${response.statusText}.`);
    process.exit(1);
  }

  return response.text();
}

/** Yield daily counts extracted from the contributions calendar. */
function* parseContributionsCalendar(contributionsCalendar: string): Generator<number> {
  let found = false;

  // The markup GitHub used to serve: one data-count attribute per day.
  for (const line of contributionsCalendar.split('\n')) {
    for (const day of line.split(/\s+/)) {
      if (day.includes('data-count=')) {
        found = true;
        yield parseInt(day.split('=')[1]!.replaceAll('"', ''), 10);
      }
    }
  }

  if (found) {
    return;
  }

  // The markup GitHub serves now: the count only appears in the day's tooltip,
  // as "12 contributions on May 3rd." or "No contributions on May 3rd.".
  for (const match of contributionsCalendar.matchAll(
    /<tool-tip[^>]*>\s*(No|[\d,]+)\s+contribution/g,
  )) {
    const count = match[1]!;
    yield count === 'No' ? 0 : parseInt(count.replaceAll(',', ''), 10);
  }
}

/** Finds the highest number of commits in one day. */
function findMaxDailyCommits(contributionsCalendar: string): number {
  let max = 0;
  let found = false;
  for (const count of parseContributionsCalendar(contributionsCalendar)) {
    max = found ? Math.max(max, count) : count;
    found = true;
  }
  if (!found) {
    console.log('That profile has no contribution calendar to read. Check the username.');
    process.exit(1);
  }
  return max;
}

/**
 * How many commits one day needs to reach a given shade.
 *
 * GitHub picks a square's shade by comparing that day against your busiest day
 * of the year, in four bands. So the palest shade needs a single commit, not a
 * whole multiplier's worth: anything up to a quarter of the busiest day looks
 * exactly the same. Only the darkest squares need real volume.
 */
function commitsForLevel(level: number, darkestDay: number): number {
  if (level <= 0) {
    return 0;
  }
  if (level >= 4) {
    return darkestDay;
  }
  return Math.floor((darkestDay * (level - 1)) / 4) + 1;
}

/**
 * Returns a Date for the first sunday after one year ago today at 12:00 noon.
 */
function getStartDate(): Date {
  const today = new Date();
  const date = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate(), 12);

  while (date.getDay() !== 0) {
    date.setDate(date.getDate() + 1);
  }

  return date;
}

/** Walks the drawing column by column, one calendar day per pixel. */
function* generateDays(
  image: number[][],
  startDate: Date,
  offset = 0,
): Generator<{ date: Date; level: number }> {
  const height = 7;
  const width = image[0]!.length;

  let day = offset * 7;
  for (let w = 0; w < width; w++) {
    for (let h = 0; h < height; h++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + day);
      day += 1;
      yield { date, level: image[h]![w] ?? 0 };
    }
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** The commit date in git's raw format: seconds since the epoch, plus zone. */
function gitTimestamp(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const zone = `${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;
  return `${Math.floor(date.getTime() / 1000)} ${sign}${zone}`;
}

/**
 * Builds a git fast-import stream for the drawing.
 *
 * The obvious way to backdate commits is a script that calls `git commit` once
 * per commit, but that spawns a process per commit and costs tens of
 * milliseconds each: a full drawing takes minutes to hours. fast-import writes
 * the same history in one pass, in seconds.
 */
function buildFastImportStream(
  image: number[][],
  startDate: Date,
  author: Author,
  branch: string,
  offset = 0,
  darkestDay = 1,
): { stream: string; commits: number; firstDate: Date; lastDate: Date } {
  const identity = `${author.name} <${author.email}>`;
  const message = `${COMMIT_MESSAGE}\n`;
  const messageBytes = Buffer.byteLength(message);

  // An empty blob, committed once so the repository has the same two files the
  // old shell script created with `touch`.
  const parts: string[] = ['blob\nmark :1\ndata 0\n\n'];

  let commits = 0;
  let firstDate = startDate;
  let lastDate = startDate;

  for (const { date, level } of generateDays(image, startDate, offset)) {
    lastDate = date;
    const stamp = gitTimestamp(date);

    for (let i = 0; i < commitsForLevel(level, darkestDay); i++) {
      if (commits === 0) {
        firstDate = date;
      }
      parts.push(
        `commit refs/heads/${branch}\n`,
        `author ${identity} ${stamp}\n`,
        `committer ${identity} ${stamp}\n`,
        `data ${messageBytes}\n${message}`,
        commits === 0 ? 'M 644 :1 README.md\nM 644 :1 text_to_commit_history\n' : '',
        '\n',
      );
      commits += 1;
    }
  }

  return { stream: parts.join(''), commits, firstDate, lastDate };
}

function bashRunner(repo: string, remote: string, branch: string): string {
  return (
    '#!/usr/bin/env bash\n' +
    'set -e\n' +
    `REPO=${JSON.stringify(repo)}\n` +
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
    'git init -b ' +
    branch +
    ' "$REPO"\n' +
    'cd "$REPO"\n' +
    `git fast-import --quiet < "$HERE/${STREAM_FILENAME}"\n` +
    `git checkout ${branch}\n` +
    `git remote add origin ${JSON.stringify(remote)}\n` +
    `git push -u origin ${branch}\n`
  );
}

function powerShellRunner(repo: string, remote: string, branch: string): string {
  // Single-quoted PowerShell strings are literal; a quote inside is doubled.
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

  return (
    '#!/usr/bin/env pwsh\n' +
    "$ErrorActionPreference = 'Stop'\n" +
    `$REPO = ${quote(repo)}\n` +
    '$here = Split-Path -Parent $PSCommandPath\n' +
    `$stream = Join-Path $here ${quote(STREAM_FILENAME)}\n` +
    `git init -b ${branch} $REPO\n` +
    'Set-Location $REPO\n' +
    '# PowerShell has no input redirection, so hand the stream to git via cmd.\n' +
    'cmd /c "git fast-import --quiet < ""$stream"""\n' +
    `git checkout ${branch}\n` +
    `git remote add origin ${quote(remote)}\n` +
    `git push -u origin ${branch}\n`
  );
}

/** Saves a generated file, marking the runner executable where that means anything. */
async function save(output: string, filename: string, executable = false): Promise<void> {
  await Bun.write(filename, output);
  if (executable) {
    try {
      await chmod(filename, 0o755);
    } catch {
      // Windows has no execute bit, so failing here is not worth reporting.
    }
  }
}

/** Asks a question, showing the default that a blank answer accepts. */
function ask(question: string, fallback = ''): string {
  const answer = (prompt(`${question}${fallback ? ` [${fallback}]` : ''}:`) ?? '').trim();
  return answer || fallback;
}

/** Asks a question that has to be answered. */
function askRequired(question: string): string {
  for (;;) {
    const answer = ask(question);
    if (answer) {
      return answer;
    }
    console.log('  That one cannot be left blank.');
  }
}

function askYesNo(question: string, fallback = false): boolean {
  const answer = ask(`${question} (y/n)`, fallback ? 'y' : 'n').toLowerCase();
  return answer.startsWith('y');
}

function gitConfig(key: string): string {
  const result = Bun.spawnSync(['git', 'config', '--get', key]);
  return result.success ? new TextDecoder().decode(result.stdout).trim() : '';
}

function flag(argv: string[], name: string): string | undefined {
  return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/**
 * The URL the generated script pushes to.
 *
 * HTTPS by default: git asks your credential helper (Git Credential Manager,
 * or the gh CLI) and that is set up on most machines already. SSH only works
 * if you have generated a key and added it to GitHub, so it is opt-in through
 * --ssh, or --ssh=git@your.host for a different server.
 */
function buildRemote(argv: string[], gitBase: string, username: string, repo: string): string {
  const host = flag(argv, 'ssh');

  if (host === undefined && !argv.includes('--ssh')) {
    return `${gitBase.endsWith('/') ? gitBase : `${gitBase}/`}${username}/${repo}.git`;
  }

  return `${host || `git@${new URL(gitBase).hostname}`}:${username}/${repo}.git`;
}

/**
 * Windows has no bash unless Git Bash is installed, so default to PowerShell
 * there. Either script can be forced with --shell=bash or --shell=powershell.
 */
function chooseShell(argv: string[]): Shell {
  const value = flag(argv, 'shell');

  if (value === undefined) {
    return process.platform === 'win32' ? 'powershell' : 'bash';
  }
  if (value === 'bash' || value === 'sh') {
    return 'bash';
  }
  if (value === 'powershell' || value === 'pwsh' || value === 'ps1') {
    return 'powershell';
  }

  console.log(`Unknown --shell=${value}, expected bash or powershell.`);
  process.exit(1);
}

/** Prints the drawing the way it will land on the calendar. */
function preview(image: number[][]): void {
  const shades = [' ', '.', '+', '#', '#'];
  console.log('');
  for (const row of image) {
    console.log(`  ${row.map((level) => shades[Math.min(level, 4)]).join('')}`);
  }
  console.log('');
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function main(): Promise<void> {
  console.log(TITLE);

  const argv = process.argv.slice(2);
  const shell = chooseShell(argv);
  const branch = flag(argv, 'branch') ?? DEFAULT_BRANCH;

  const gitBase = ask('GitHub server (change this only for GitHub Enterprise)', GITHUB_BASE_URL);
  const username = askRequired('Your GitHub username');

  console.log('\nReading your contribution calendar...');
  const calendar = await retrieveContributionsCalendar(username, gitBase);
  const maxDailyCommits = findMaxDailyCommits(calendar);
  console.log(`Your busiest day in the last year has ${maxDailyCommits} commits.\n`);

  const text = ask('Text to draw on your calendar (blank draws a cat)');

  let image: number[][];
  if (!text) {
    image = KITTY;
  } else {
    try {
      image = await getArialFontMatrix(text, CALENDAR_WEEKS);
    } catch (error) {
      console.log('Could not render that text, drawing a cat instead.');
      console.log(error);
      image = KITTY;
    }
  }

  preview(image);
  console.log(
    `The drawing is ${image[0]!.length} weeks wide, out of the ${CALENDAR_WEEKS} on your calendar.`,
  );

  const offsetInput = ask('Move it right by how many weeks', '0');
  const offset = Math.max(0, Number.parseInt(offsetInput, 10) || 0);

  if (offset + image[0]!.length > CALENDAR_WEEKS) {
    console.log(
      `Careful: ${offset} weeks of offset puts the last ${
        offset + image[0]!.length - CALENDAR_WEEKS
      } weeks of the drawing past the end of the calendar, where they will not show.`,
    );
  }

  console.log(
    '\nBy default the darkest squares of the drawing match your busiest day, so the\n' +
      'drawing blends in with your real activity. Saying yes below makes them four\n' +
      'times darker, so the drawing stands out, at the cost of four times the commits.',
  );
  const boost = askYesNo('Draw darker than your busiest day?', false);
  const darkestDay = Math.max(1, maxDailyCommits * (boost ? 4 : 1));

  const repo = askRequired('\nName of the new (empty!) repository these commits go to');

  const remote = buildRemote(argv, gitBase, username, repo);

  const author: Author = {
    name: flag(argv, 'name') || gitConfig('user.name') || username,
    email: flag(argv, 'email') || gitConfig('user.email') || `${username}@users.noreply.github.com`,
  };

  const startDate = getStartDate();
  const { stream, commits, firstDate, lastDate } = buildFastImportStream(
    image,
    startDate,
    author,
    branch,
    offset,
    darkestDay,
  );

  const runner = RUNNER_FILENAME[shell];
  await save(stream, STREAM_FILENAME);
  await save(
    shell === 'powershell'
      ? powerShellRunner(repo, remote, branch)
      : bashRunner(repo, remote, branch),
    runner,
    true,
  );

  console.log(
    `\nWrote ${runner} and ${STREAM_FILENAME}.\n` +
      `  ${commits.toLocaleString('en-US')} commits, ${formatDate(firstDate)} to ${formatDate(lastDate)}\n` +
      `  authored as ${author.name} <${author.email}>\n` +
      `  pushed to ${remote} on branch ${branch}\n`,
  );
  console.log(
    'GitHub only counts commits whose author email belongs to your account, and only\n' +
      `on the repository's default branch, which is why the script pushes ${branch}.\n`,
  );
  if (remote.startsWith('http')) {
    console.log(
      'The push goes over HTTPS, so git will ask your credential helper to log in. If\n' +
        'it cannot, run "gh auth login" (or "gh auth setup-git" when already logged in).\n' +
        'Pass --ssh instead if you have an SSH key on GitHub.\n',
    );
  }
  console.log(`Create the empty repository ${repo} at ${gitBase}, then run this from a`);
  console.log('directory that is not itself a git repository:');
  console.log(
    shell === 'powershell'
      ? `  powershell -ExecutionPolicy Bypass -File ${runner}`
      : `  ./${runner}`,
  );
  console.log('\nIt takes seconds. Your calendar catches up within a day or so.');
}

if (import.meta.main) {
  await main();
}

export {
  buildFastImportStream,
  commitsForLevel,
  findMaxDailyCommits,
  getStartDate,
  KITTY,
  powerShellRunner,
  bashRunner,
};
