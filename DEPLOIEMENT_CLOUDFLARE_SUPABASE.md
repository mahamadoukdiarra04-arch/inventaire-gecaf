# Deploiement Cloudflare Pages + Supabase

## 1. Supabase

1. Creer un projet Supabase gratuit.
2. Ouvrir `SQL Editor`.
3. Coller et executer le contenu de `supabase/schema.sql`.
4. Dans `Project Settings > API`, recuperer :
   - `Project URL`
   - `anon public key`
5. Pour un deploiement Git Cloudflare, ajouter ces variables dans Cloudflare Pages :
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`

   Le build generera automatiquement `dist/supabase-config.js`.

   Pour un test local rapide sans build, il est aussi possible de remplir `supabase-config.js` :

```js
window.GECAF_CONFIG = {
  supabaseUrl: "https://VOTRE-PROJET.supabase.co",
  supabaseAnonKey: "VOTRE_ANON_KEY",
  syncIntervalMs: 5000,
};
```

## 2. Cloudflare Pages

1. Creer un projet Cloudflare Pages.
2. Connecter le depot Git.
3. Build command : `npm run build`.
4. Build output directory : `dist`.
5. Deployer.

En deploiement direct depuis ce poste :

```bash
npm run build
npx wrangler pages deploy dist --project-name gecaf-inv
```

## 3. Connexion

- Utilisateur terrain : `Equipe` + `Agent`.
- Admin : `equipe_admin` + `admin1`.

L'admin peut creer les equipes et les agents depuis l'interface admin.

## 4. Offline et synchronisation

- La fiche reste utilisable sans connexion.
- Les modifications sont gardees localement en IndexedDB et dans une file de synchronisation.
- Quand internet revient, l'app envoie les changements a Supabase.
- Les autres membres de la meme equipe voient la fiche evoluer via Supabase Realtime.

Note importante : ce mode conserve les identifiants simples demandes (`Equipe` + `Agent`). Pour une securite serveur forte, il faudra ensuite remplacer cette couche par Supabase Auth ou par des fonctions RPC signees.
