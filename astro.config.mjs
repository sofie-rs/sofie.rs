import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// GitHub Pages serves it at the domain public/CNAME names.
export default defineConfig({
	site: 'https://sofie.rs',
	integrations: [
		starlight({
			title: 'Sofie',
			logo: { src: './src/assets/logo.png', alt: '' },
			favicon: '/favicon.png',
			customCss: ['./src/styles/custom.css'],
			head: [{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } }],
			description:
				'A Rust web framework that derives an app’s wiring, endpoints, screens and checks from its structure.',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/sofie-rs/sofie' }],
			editLink: { baseUrl: 'https://github.com/sofie-rs/sofie.rs/edit/main/' },
			sidebar: [
				{ label: 'Start here', items: ['start/getting-started', 'start/first-page', 'start/how-it-works'] },
				{ label: 'Why Sofie', items: [{ autogenerate: { directory: 'why' } }] },
				{ label: 'Architecture', items: [{ autogenerate: { directory: 'architecture' } }] },
				{ label: 'Features', items: [{ autogenerate: { directory: 'features' } }] },
				{ label: 'Reference', collapsed: true, items: [{ autogenerate: { directory: 'reference' } }] },
			],
		}),
	],
});
