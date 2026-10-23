// Writes the reference pages from what `sofie gen` writes into the sofie repository's example
// app, so they change with the framework rather than being kept by hand.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repository = process.env.SOFIE_REPO ?? 'sofie';
const example = join(repository, 'examples', 'shop');
const output = join('src', 'content', 'docs', 'reference');

const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const source = `Generated from [sofie](https://github.com/sofie-rs/sofie/tree/${commit}) at \`${commit.slice(0, 7)}\`.`;

const agents = readFileSync(join(example, 'AGENTS.md'), 'utf8');
const environment = readFileSync(join(example, '.env.example'), 'utf8');

mkdirSync(output, { recursive: true });
// AGENTS.md speaks of itself and of its own later sections.
const commands = section(agents, 'Commands')
	.replace('`.env.example`, this file)', '`.env.example`, `AGENTS.md`)')
	.replace('every rule below', 'every one of the [rules](../rules/)');

write('commands', 1, 'Commands', 'Every sofie command and generator.', [
	commands,
	'## Adding code',
	section(agents, 'How to add'),
]);
write('environment', 2, 'Environment variables', 'Every setting the framework reads at boot.', [
	'An app’s own `.env.example`, which `sofie gen` keeps current, lists the ones its features read. ' +
		'Required ones have no default.',
	frameworkSettings(environment),
]);
write('layout', 3, 'Where code goes', 'The place of every file in an app.', [section(agents, 'Where code goes')]);
write('rules', 4, 'Rules', 'What `sofie check` holds every app to.', [
	'A finding fails `cargo build`, as the app’s build script runs `sofie check`.',
	section(agents, 'Rules `sofie check` holds the app to'),
]);

function write(slug, order, title, description, parts) {
	const frontmatter = [
		'---',
		`title: ${JSON.stringify(title)}`,
		`description: ${JSON.stringify(description)}`,
		'editUrl: false',
		'sidebar:',
		`  order: ${order}`,
		'---',
	].join('\n');
	writeFileSync(join(output, `${slug}.md`), `${frontmatter}\n\n${[...parts, `_${source}_`].join('\n\n')}\n`);
}

/** The body of the `## heading` section of a Markdown file, up to the next `## `. */
function section(markdown, heading) {
	const start = markdown.indexOf(`\n## ${heading}\n`);
	if (start === -1) {
		throw new Error(`AGENTS.md of the example app has no "## ${heading}" section`);
	}
	const body = markdown.slice(start + heading.length + 5);
	const end = body.indexOf('\n## ');
	return (end === -1 ? body : body.slice(0, end)).trim();
}

/** `.env.example` entries: comment lines describing a key, then `KEY=` or `# KEY=`. */
function frameworkSettings(text) {
	const entries = text
		.split(/\n\s*\n/)
		.map((block) => block.split('\n').filter((line) => line.trim() !== ''))
		.map((lines) => {
			const last = lines.at(-1) ?? '';
			const key = /^(#\s*)?([A-Z][A-Z0-9_]*)=/.exec(last);
			if (!key) {
				return undefined;
			}
			const described = lines.slice(0, -1).map((line) => line.replace(/^#\s?/, ''));
			return { name: key[2], required: key[1] === undefined, description: described.join(' ') };
		})
		.filter((entry) => entry && (entry.name.startsWith('SOFIE_') || entry.name === 'DATABASE_URL'));
	if (entries.length < 20) {
		throw new Error(`.env.example of the example app lists only ${entries.length} framework settings`);
	}
	return entries
		.map(({ name, required, description }) => `- **\`${name}\`**${required ? ' (required)' : ''}: ${description}`)
		.join('\n');
}
