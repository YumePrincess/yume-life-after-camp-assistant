# Guide de déploiement

Langues : [English (par défaut)](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) ·
[繁體中文](DEPLOYMENT.zh-TW.md) · Français · [日本語](DEPLOYMENT.ja.md)

Ce guide déploie le site et l’API du camp sur Cloudflare Workers et configure
l’Agent Mac local facultatif. Créez une base D1 et un bucket R2 dédiés à cette
installation ; ne reliez pas un aperçu aux données d’un autre site.

## Pourquoi Workers ? Le déploiement peut-il être gratuit ?

Workers évite de provisionner et de maintenir un serveur toujours actif. Le site,
l’API et les fichiers statiques sont déployés ensemble ; Cloudflare gère le
runtime périphérique et les liaisons connectent D1, R2 et Durable Objects. Le nom
`workers.dev` permet un premier déploiement ou un aperçu sans domaine personnalisé.
Aucun forfait Workers payant n’est requis : un petit camp peut utiliser Workers
Free tant que son utilisation de Workers, D1, Durable Objects et R2 reste dans
les quotas gratuits actuels. Ces quotas sont limités et peuvent changer ; les
dépassements et services payants ou tiers peuvent entraîner des frais. Consultez
les [limites Workers](https://developers.cloudflare.com/workers/platform/limits/),
les [tarifs Workers](https://developers.cloudflare.com/workers/platform/pricing/)
et les [tarifs R2](https://developers.cloudflare.com/r2/pricing/).

## 1. Préparer Cloudflare

Il faut un compte Cloudflare, Node.js 22 ou plus récent et un terminal. Depuis
la racine du dépôt :

```sh
cd Workers
npm install
cp wrangler.example.jsonc wrangler.jsonc
```

Modifiez `wrangler.jsonc` :

1. Choisissez un nom Worker `name` unique. Gardez `workers_dev: true` pour une
adresse provisoire `workers.dev`. Configurez un domaine personnalisé seulement
après la préparation de sa zone DNS.
2. Créez une base D1 et un bucket R2. Renseignez l’ID et le nom de la base dans
la liaison `DB`, puis le nom du bucket dans `FILES`. Conservez
`migrations_dir: "migrations"`.
3. Gardez les quatre liaisons Durable Objects, les migrations, Assets et le
déclencheur planifié. N’utilisez pas les ressources de production pour un aperçu.

Wrangler peut créer les ressources :

```sh
npx wrangler d1 create yume-camp-assistant
npx wrangler r2 bucket create yume-camp-assistant-files
```

### Champs Wrangler à configurer

| Champ | Configuration |
| --- | --- |
| `name` | Choisissez un nom Worker unique ; il forme la première partie de l’URL `workers.dev`. |
| `workers_dev` / `preview_urls` | Pour utiliser `workers.dev`, gardez `workers_dev: true` et `preview_urls: false` : l’URL Worker reste publique et les URL d’aperçu par version sont désactivées. |
| `routes` | N’ajoutez pas ce champ pour un déploiement `workers.dev`. Pour un domaine personnalisé dans une zone DNS Cloudflare, ajoutez plus tard sa route avec `custom_domain: true`. |
| `DB` | Gardez `binding: "DB"` ; remplacez `database_name` et `database_id` par le nom et l’ID de la base D1 créée. Gardez `migrations_dir: "migrations"` et utilisez le même nom dans la commande de migration. |
| `FILES` | Gardez `binding: "FILES"` ; indiquez dans `bucket_name` le nom du bucket R2 créé. |
| `vars.ENVIRONMENT` | Choisissez un libellé comme `production` ou `preview` ; utilisez `preview` pour un test isolé. |
| `vars.STORAGE_PREFIX` | Préfixe des clés d’objet R2. Si plusieurs installations partagent un bucket, choisissez un préfixe différent pour chacune. |
| `vars.OIDC_ENABLED` | Mettez `false` pour une connexion par Key uniquement, ou `true` après avoir configuré un fournisseur OIDC. |
| Autres `vars.OIDC_*` | À configurer seulement avec OIDC : `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `OIDC_POST_LOGOUT_REDIRECT_URI`, `OIDC_ALLOWED_SUBJECTS`, `OIDC_SCOPES`, `OIDC_EMAIL_CLAIM`, `OIDC_AUTO_LOGIN`, `OIDC_TOKEN_AUTH_METHOD` et `OIDC_SESSION_CHECK_INTERVAL_SECONDS`. Le rappel est `<URL du site>/auth/oidc/callback` ; la liste d’accès contient des valeurs `sub`, pas des e-mails. |
| `secrets` | Ajoutez les valeurs secrètes ci-dessous avec Wrangler Secrets. Ne placez jamais les valeurs dans `vars` ni dans un fichier commit. |
| `assets`, `durable_objects`, `migrations`, `triggers`, `observability` | Gardez les assets, les quatre liaisons Durable Objects, les tags de migration, le déclencheur planifié et la journalisation fournis, sauf changement volontaire de l’architecture. |

La configuration d’exemple omet `routes` : le déploiement utilise donc l’URL
`workers.dev` affichée par Wrangler. Pour un domaine personnalisé, ajoutez ce
bloc après avoir préparé sa zone DNS et remplacez le nom de domaine :

```jsonc
"routes": [{ "pattern": "camp.example.com", "custom_domain": true }]
```

## 2. Configurer l’authentification administrateur

OIDC est facultatif. La console accepte OIDC ou une clé via le même écran de
connexion. **Configuration avec clé uniquement :**

1. Définissez `OIDC_ENABLED` sur `false` dans `wrangler.jsonc`.
2. Enregistrez la clé permanente d’administration comme secret Worker. Elle
reste valide jusqu’à la rotation du secret :

   ```sh
   npx wrangler secret put ADMIN_TEMPORARY_KEY
   ```

3. Générez des valeurs aléatoires indépendantes d’au moins 32 octets pour les
secrets requis :

   ```sh
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put AGENT_SHARED_TOKEN
   ```

`SESSION_SECRET` signe les sessions et chiffre les secrets côté serveur ; gardez
sa valeur stable entre les déploiements, car sa rotation invalide les sessions
et données chiffrées existantes. `AGENT_SHARED_TOKEN` authentifie l’Agent local
et doit être saisi à l’identique dans l’application Mac. `ADMIN_TEMPORARY_KEY`
est nécessaire avec une connexion Key uniquement, mais facultative avec OIDC
seul. Configurez `OIDC_CLIENT_SECRET` uniquement si la méthode d’authentification
du jeton du fournisseur l’exige.

Saisissez `ADMIN_TEMPORARY_KEY` dans le champ de connexion Key, comme pour les
clés créées dans la console. La clé Wrangler n’expire pas ; sa rotation
l’invalide. Les clés créées dans la console permettent un nom, une échéance,
une révocation et des permissions par module.

Pour OIDC, définissez `OIDC_ENABLED` sur `true`, puis configurez l’issuer, le
Client ID, l’URL de retour et l’URL après déconnexion. Enregistrez le secret
client dans `OIDC_CLIENT_SECRET` si la méthode d’authentification du jeton
l’exige. `OIDC_ALLOWED_SUBJECTS` contient les valeurs `sub` OIDC autorisées,
séparées par des virgules, et non des adresses e-mail. Gardez tous les secrets
dans Wrangler Secrets ou le tableau de bord Cloudflare, jamais dans `vars` ou
dans des fichiers commités.

## 3. Migrer la base et déployer

Appliquez toutes les migrations D1 en attente à la nouvelle base, puis validez
et déployez :

```sh
npx wrangler d1 migrations apply yume-camp-assistant --remote --config wrangler.jsonc
npm run check
npm run deploy
```

Wrangler affiche l’URL du Worker. Avec `workers_dev: true`, elle ressemble à
`https://<worker-name>.<account-subdomain>.workers.dev`. Vérifiez la page
d’accueil et `/login`, puis connectez-vous à `/admin` avec la clé permanente.
Configurez le nom du camp, le serveur, le fuseau horaire, le contenu public et
les plannings. Configurez SMTP dans la console si les demandes et récupérations
d’identité doivent envoyer des e-mails. Domaine personnalisé et DNS public sont
facultatifs.

Pour un WebView WeChat Mini Program, ajoutez le nom d’hôte HTTPS déployé aux
listes d’autorisation « request » et « web-view » de la plateforme WeChat.

## 4. Installer l’Agent Mac

L’Agent nécessite un Mac Apple Silicon, macOS 26 ou ultérieur, l’édition
continentale chinoise de l’émulateur Android MuMu, le client LifeAfter des
serveurs de Chine continentale et Android platform-tools. Les workflows
d’automatisation ciblent ces éditions. Les versions internationales peuvent
avoir des écrans et parcours différents ; leurs utilisateurs doivent adapter
eux-mêmes le code source concerné. L’Agent utilise le port ADB loopback local de
MuMu ; n’exposez pas ADB sur Internet. Installez LifeAfter depuis la boutique
d’applications intégrée à MuMu. Dans les paramètres du jeu, remplacez la touche
de libération de la souris `~` par défaut par `=` ; l’Agent utilise `=`.

En Chine continentale, le modèle de vision local facultatif peut ne pas se télécharger
avec une connexion Internet directe. Si vous souhaitez l’utiliser, organisez vous-même
l’accès réseau ou l’obtention des fichiers du modèle.

L’Agent d’automatisation est actuellement pris en charge uniquement sur les Mac Apple Silicon sous macOS 26 ou ultérieur. Le projet peut ne pas développer d’Agent supplémentaire pour Windows ou d’autres plateformes.

L’automatisation de jeu de la version open source avait passé les tests au
22 novembre 2026. Les mises à jour ultérieures de LifeAfter peuvent modifier
les touches, les parcours ou les positions d’action ; le projet peut ne pas
fournir de correctif ni de nouvelle version pour ces changements.

### Utiliser l’application native

Construisez l’application dans `MacApp/` ou installez un `.dmg` publié :

```sh
cd MacApp
./scripts/build-app.sh
```

Au premier lancement, suivez l’assistant :

1. **URL Workers :** collez l’URL HTTPS complète affichée par Wrangler, par
   exemple `https://<worker>.<account-subdomain>.workers.dev`. N’ajoutez pas
   `/admin`.
2. **Nom de l’appareil Agent :** choisissez un nom facile à reconnaître et
   différent pour chaque Mac.
3. **Nom du conteneur MuMu :** saisissez le nom exact affiché dans MuMu. L’Agent
   s’y associe par son nom et détecte automatiquement le port ADB local.
4. **Agent token :** saisissez la même valeur que le secret Worker
   `AGENT_SHARED_TOKEN`.
5. **Jeton de diagnostic local :** créez un jeton aléatoire distinct pour l’API
   de contrôle locale de l’Agent. Ne réutilisez pas le jeton Worker ; il reste
   sur ce Mac.
6. **Admin access Key (facultative) :** saisissez `ADMIN_TEMPORARY_KEY` ou une
   Key créée dans la console si vous voulez que la vue d’administration intégrée
   l’utilise. Laissez le champ vide pour vous connecter manuellement si besoin.
7. L’application génère l’ID stable de l’appareil ; ne le modifiez pas. Le
   fuseau affiché suit celui du camp dans Workers. Vérifiez les valeurs puis
   choisissez **Save, Install and Finish** : l’application enregistre la
   configuration et les identifiants locaux, inscrit le LaunchAgent et vérifie
   son état.

Ensuite, consultez les journaux, démarrez/arrêtez l’Agent, lancez les tâches,
gérez les plugins, réparez l’installation et ouvrez la console Web. Un Agent en
ligne ne lance pas de tâche de jeu de lui-même ; configurez et activez les
tâches voulues dans la console.

### Installation en ligne de commande

Dans `Mac/`, créez une configuration locale depuis `config.example.json`,
renseignez l’URL du serveur et le même `AGENT_SHARED_TOKEN`, puis installez et
vérifiez :

```sh
cd Mac
cp config.example.json config.json
./scripts/manage-local-agent.sh install
./scripts/manage-local-agent.sh status
```

Protégez `config.json`. Pour le modèle local, l’émulateur, le dépannage et le
calibrage des tâches, consultez [`Mac/README.md`](../Mac/README.md) et
[`MacApp/README.md`](../MacApp/README.md).

## 5. Exploiter le camp

Après une nouvelle installation, toutes les tâches planifiées sont désactivées
par défaut. Vérifiez l’émulateur, les horaires et les données du camp, puis
activez uniquement les tâches nécessaires, une par une.

1. Ajoutez les annonces et instructions de groupe réelles ; remplacez les QR
   codes d’exemple avant d’inviter les membres.
2. Configurez les critères de demande d’identité et la procédure d’approbation.
3. Réglez les horaires de vote technologique, l’éligibilité, les sondages/tirages
   et les choix technologiques fixes. Le catalogue technologique est incomplet,
   car notre camp n’a pas tout débloqué. Ajoutez vous-même les options
   manquantes au code source ; nous ne promettons pas de compléter le catalogue
   dans une version future.
4. Sélectionnez l’appareil Agent actif et n’activez que les automatisations
   prêtes pour le camp. Commencez par des exécutions manuelles et vérifiez leurs
   résultats avant de vous fier au planning.
5. Consultez l’historique des tâches, les instantanés de membres/contributions,
   les alertes et les paramètres de chat.

Le projet n’héberge pas de comptes de jeu et ne propose pas d’expulsion des
membres. Le [README](../README.md) décrit toutes les fonctions, la licence et
les contenus tiers.
