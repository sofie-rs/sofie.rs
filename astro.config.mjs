import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Served from the organization's GitHub Pages until sofie.rs points at it; then `site`
// becomes https://sofie.rs, `base` goes and public/CNAME names the domain.
export default defineConfig({
	site: 'https://sofie-rs.github.io',
	base: '/sofie.rs',
	integrations: [
		starlight({
			title: 'sofie',
			description:
				'A Rust web framework that derives an app’s wiring, endpoints, screens and checks from its structure.',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sofie-rs/sofie' }],
			editLink: { baseUrl: 'https://github.com/sofie-rs/sofie.rs/edit/main/' },
			sidebar: [
				{ label: 'Start here', items: ['start/getting-started', 'start/how-it-works'] },
				{ label: 'Why sofie', items: [{ autogenerate: { directory: 'why' } }] },
				{ label: 'Architecture', items: [{ autogenerate: { directory: 'architecture' } }] },
				{ label: 'Features', items: [{ autogenerate: { directory: 'features' } }] },
				{ label: 'Reference', collapsed: true, items: [{ autogenerate: { directory: 'reference' } }] },
			],
		}),
	],
});
