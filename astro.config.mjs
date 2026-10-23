import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Served from the organization's GitHub Pages until sofie.rs points at it; then `site`
// becomes https://sofie.rs, `base` goes and public/CNAME names the domain.
const base = '/sofie.rs';

export default defineConfig({
	site: 'https://sofie-rs.github.io',
	base,
	integrations: [
		starlight({
			title: 'Sofie',
			logo: { src: './src/assets/logo.png', alt: '' },
			favicon: '/favicon.png',
			customCss: ['./src/styles/custom.css'],
			head: [{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}/apple-touch-icon.png` } }],
			description:
				'A Rust web framework that derives an app’s wiring, endpoints, screens and checks from its structure.',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sofie-rs/sofie' }],
			editLink: { baseUrl: 'https://github.com/sofie-rs/sofie.rs/edit/main/' },
			sidebar: [
				{ label: 'Start here', items: ['start/getting-started', 'start/how-it-works'] },
				{ label: 'Why Sofie', items: [{ autogenerate: { directory: 'why' } }] },
				{ label: 'Architecture', items: [{ autogenerate: { directory: 'architecture' } }] },
				{ label: 'Features', items: [{ autogenerate: { directory: 'features' } }] },
				{ label: 'Reference', collapsed: true, items: [{ autogenerate: { directory: 'reference' } }] },
			],
		}),
	],
});
