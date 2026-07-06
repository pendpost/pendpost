// playbooks.mjs - the PROSE source of truth for per-platform vendor onboarding:
// the portal to open, the app/products to create, the OAuth scopes to request, the
// ordered steps, and the failures operators hit most. It is the "how do I actually
// connect this lane" companion to setup.mjs's machine-readable gap signal.
//
// WHY this is plain English DATA and NOT routed through t(): these are AUTHORITATIVE
// vendor instructions (Meta/LinkedIn/X/Google portal flows, exact scope strings, exact
// env var names, exact CLI invocations). Translating them would risk drifting a
// load-bearing scope name or portal label out of sync with the vendor; a mistranslated
// scope is a broken connect. The UI may localize the SHORT chrome around this prose
// (headings, "copy", "open portal") via t(), but the playbook body stays English.
//
// FROZEN field set per entry (C5) - PROSE ONLY:
//   { portalUrl, appToCreate, productsToAdd:[], scopes:[],
//     steps:[{ title, detail, env?, field?, cli? }],
//     commonFailures:[{ symptom, cause, fix }] }
// It holds NO identifiers / secret summary / connect command - those STAY in
// setup.mjs PLATFORM_SETUP (the load-bearing acctField/required/connect), so there is
// exactly one home for each fact. Keyed by the SAME platform list as setup.mjs; the
// key-parity test (test/playbooks.test.mjs) guards against drift.

export const PLAYBOOKS = {
  meta: {
    portalUrl: 'https://developers.facebook.com/apps',
    appToCreate: 'a Business app',
    productsToAdd: ['Instagram Graph API', 'Facebook Login for Business'],
    scopes: [
      'instagram_basic',
      'instagram_content_publish',
      'pages_show_list',
      'pages_read_engagement',
      'business_management',
    ],
    steps: [
      {
        title: 'Create a Business app',
        detail:
          'In the Meta App Dashboard, create a new app and choose the "Business" type. ' +
          'Note its App ID and App Secret (App Settings -> Basic).',
        env: 'META_APP_ID, META_APP_SECRET',
      },
      {
        title: 'Add the publishing products',
        detail:
          'Add the "Instagram Graph API" and "Facebook Login for Business" products to the app. ' +
          'Instagram publishing requires a Facebook Page connected to an Instagram professional (Business or Creator) account.',
      },
      {
        title: 'Link the Page to the Instagram account',
        detail:
          'In the Page settings, link the Facebook Page to the Instagram professional account that will publish. ' +
          'Record the Page ID and the Instagram User ID the app will post as.',
        field: 'metaPageId, metaIgUserId',
      },
      {
        title: 'Mint a long-lived System User token',
        detail:
          'In Business Settings -> System Users, create a System User, assign it the Page with full control, and generate a token ' +
          'granting the scopes above. Then exchange it for a long-lived Page token via the CLI below - the token never touches this dashboard.',
        cli:
          'node scripts/meta-social.mjs setup-system-user --system-user-token <SYSTEM_USER_TOKEN> ' +
          '--page-id <ID> --app-id <ID> --app-secret <S>',
        env: 'META_PAGE_ID, META_IG_USER_ID, META_SYSTEM_USER_TOKEN',
      },
    ],
    commonFailures: [
      {
        symptom: 'Publishing returns a permissions error even though the token works for reads.',
        cause: 'The token was minted without the instagram_content_publish scope.',
        fix: 'Re-generate the System User token with instagram_content_publish (and instagram_basic) granted, then re-run the setup CLI.',
      },
      {
        symptom: 'The API reports no Instagram account is available for the Page.',
        cause: 'The Facebook Page is not linked to an Instagram professional account.',
        fix: 'Link the Page to an Instagram Business or Creator account in Page settings, then re-check the lane.',
      },
      {
        symptom: 'Calls 404 or post to the wrong place.',
        cause: 'The configured Page ID belongs to a different Page than the one the token controls.',
        fix: 'Confirm the Page ID (META_PAGE_ID) matches the Page the System User was granted, and the IG User ID belongs to that Page.',
      },
    ],
  },

  linkedin: {
    portalUrl: 'https://www.linkedin.com/developers/apps',
    appToCreate: 'an app associated with a Company Page you administer',
    productsToAdd: [
      'Community Management API',
      'Share on LinkedIn',
      'Sign In with LinkedIn using OpenID Connect',
    ],
    scopes: [
      'w_member_social',
      'r_organization_social',
      'w_organization_social',
      'rw_organization_admin',
    ],
    steps: [
      {
        title: 'Create the app',
        detail:
          'Create a LinkedIn developer app and associate it with the Company Page you will publish for. ' +
          'You must hold an admin role on that Page for organization posting to work.',
      },
      {
        title: 'Request the products',
        detail:
          'Under the Products tab, request the "Community Management API" plus "Share on LinkedIn" and "Sign In with LinkedIn". ' +
          'Organization (Company Page) posting requires the Community Management API; member posting needs Share on LinkedIn. ' +
          'Some products require review and may stay pending until approved.',
      },
      {
        title: 'Record the organization URN',
        detail:
          'Find the Company Page ID and form its URN as urn:li:organization:<digits>. ' +
          'This is the target the engine posts to.',
        field: 'linkedinOrgUrn',
      },
      {
        title: 'Run the OAuth flow',
        detail:
          'Run the CLI below to complete the OAuth authorization in the browser and store the access + refresh tokens. ' +
          'The token exchange happens in the CLI - this dashboard never sees the raw token.',
        cli: 'node scripts/linkedin-social.mjs auth',
      },
    ],
    commonFailures: [
      {
        symptom: 'Organization posts are rejected with an authorization error.',
        cause: 'The authorizing member is not an admin of the Company Page.',
        fix: 'Grant the member a page admin role on the Company Page, then re-run the auth flow.',
      },
      {
        symptom: 'The requested scope is denied at authorization time.',
        cause: 'The Community Management API product is still pending review or not added.',
        fix: 'Add and wait for approval of the Community Management API product, then re-authorize.',
      },
      {
        symptom: 'Posts succeed but appear under the wrong organization (or 404).',
        cause: 'The configured org URN points at the wrong Company Page.',
        fix: 'Verify LINKEDIN_ORG_URN is urn:li:organization:<digits> for the intended Page.',
      },
    ],
  },

  x: {
    portalUrl: 'https://developer.x.com/en/portal/dashboard',
    appToCreate: 'a Project, then an App inside it',
    productsToAdd: ['User authentication settings: OAuth 1.0a (Read and Write)'],
    scopes: [
      // OAuth 2.0 PKCE alternative scopes (OAuth 1.0a does not use scope strings).
      'tweet.read',
      'tweet.write',
      'users.read',
      'media.write',
      'offline.access',
    ],
    steps: [
      {
        title: 'Create a Project and an App',
        detail:
          'In the X developer portal, create a Project and add an App inside it. Standalone apps cannot post; the App must live in a Project.',
      },
      {
        title: 'Set User authentication to Read and Write FIRST',
        detail:
          'Open the App\'s "User authentication settings" and set the app permissions to "Read and Write" BEFORE generating any tokens. ' +
          'Generating tokens while the app is Read-only mints read-only tokens.',
      },
      {
        title: 'Generate OAuth 1.0a keys and tokens (recommended)',
        detail:
          'OAuth 1.0a is the recommended path. Generate BOTH the API Key/Secret (consumer keys) AND the Access Token/Secret. ' +
          'Order matters: if you regenerate the API Key/Secret, regenerate the Access Token/Secret AFTERWARD, or the old access token is invalidated.',
        env: 'X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET',
      },
      {
        title: 'OAuth 2.0 PKCE alternative',
        detail:
          'If you prefer OAuth 2.0 with PKCE, request the scopes above and set the callback URL to http://localhost:8087/callback, ' +
          'then run the CLI below to authorize in the browser. The CLI handles the token exchange.',
        cli: 'node scripts/x-social.mjs auth',
        field: 'xHandle',
      },
    ],
    commonFailures: [
      {
        symptom: '401 "Could not authenticate you" (code 32).',
        cause: 'A key or token was hand-typed and is subtly wrong, or the signature inputs are mismatched.',
        fix: 'Copy each value directly from the portal (do not retype), confirm all four OAuth 1.0a values belong to the same app, and re-run setup.',
      },
      {
        symptom: 'Auth worked yesterday but now fails.',
        cause: 'The API Key/Secret was regenerated, which invalidated the previously issued Access Token/Secret.',
        fix: 'Regenerate the Access Token/Secret AFTER any API Key/Secret change, then update all four values.',
      },
      {
        symptom: 'Reads work but posting is forbidden.',
        cause: 'The app was left at Read-only permissions when the tokens were generated.',
        fix: 'Set User authentication to "Read and Write", regenerate the Access Token/Secret, and re-run setup.',
      },
    ],
  },

  youtube: {
    portalUrl: 'https://console.cloud.google.com/apis/credentials',
    appToCreate: 'a Google Cloud project with an OAuth 2.0 client',
    productsToAdd: ['YouTube Data API v3'],
    scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
    steps: [
      {
        title: 'Create a project and enable the API',
        detail:
          'In Google Cloud Console, create a project and enable "YouTube Data API v3" under APIs & Services -> Library.',
      },
      {
        title: 'Publish the consent screen to Production',
        detail:
          'On the OAuth consent screen, add the scope https://www.googleapis.com/auth/youtube.force-ssl, then publish ' +
          'the app to Production (Google Auth Platform -> Audience -> Publish app). A Production app issues a durable ' +
          'refresh token and only asks you to confirm access once. Leaving it in Testing works for a quick trial but ' +
          'expires the token after 7 days - publish before you rely on it.',
      },
      {
        title: 'Create the OAuth client',
        detail:
          'Create an OAuth 2.0 client (Desktop or Web application). For a Web client, add the redirect URI ' +
          'http://localhost:8088/callback. Record the client ID and client secret.',
        env: 'YT_CLIENT_ID, YT_CLIENT_SECRET',
      },
      {
        title: 'Run the OAuth flow to mint a refresh token',
        detail:
          'Run the CLI below to authorize in the browser and store the refresh token. ' +
          'The token exchange happens in the CLI - this dashboard never sees the raw token. ' +
          'Expect a one-time "Google hasn\'t verified this app" screen - that is normal for your own bring-your-own ' +
          'app: click Advanced -> Go to pendpost (unsafe) to continue. No Google verification is needed.',
        cli: 'node scripts/yt-social.mjs auth',
        env: 'YT_REFRESH_TOKEN',
      },
    ],
    commonFailures: [
      {
        symptom: 'No refresh token is returned, so the lane cannot stay authenticated.',
        cause: 'Google only issues a refresh token on the first consent for a client.',
        fix: 'Force a fresh consent (add prompt=consent / access_type=offline), or revoke prior access for the app and re-run auth.',
      },
      {
        symptom: 'The token stops working after about a week.',
        cause: 'The consent screen is still in Testing mode, where refresh tokens expire in 7 days.',
        fix: 'Publish the app to Production (step 2) for a long-lived refresh token.',
      },
      {
        symptom: 'Uploads or updates are rejected with insufficient permissions.',
        cause: 'The youtube.force-ssl scope was not granted during consent.',
        fix: 'Add https://www.googleapis.com/auth/youtube.force-ssl to the consent screen and re-authorize.',
      },
    ],
  },

  telegram: {
    portalUrl: 'https://t.me/BotFather',
    appToCreate: 'a Bot (via @BotFather) that posts to your channel',
    productsToAdd: [],
    scopes: [],
    steps: [
      {
        title: 'Create a bot with BotFather',
        detail:
          'Open Telegram, message @BotFather, send /newbot, and follow the prompts. ' +
          'BotFather hands you an HTTP API token - that is the only credential pendpost needs.',
        env: 'TELEGRAM_BOT_TOKEN',
      },
      {
        title: 'Create the destination channel',
        detail:
          'Create the channel you want to post to. A public channel with an @username gives clean post permalinks; ' +
          'a private channel works too but has no shareable links. Record its @username (or numeric chat id).',
        env: 'TELEGRAM_CHANNEL_ID',
      },
      {
        title: 'Add the bot as a channel admin',
        detail:
          'In the channel, add the bot as an administrator and grant it "Post Messages". ' +
          'Without admin rights the bot cannot publish.',
      },
      {
        title: 'Confirm the connection',
        detail:
          'Run the CLI below to verify the token authenticates and the bot can reach the channel. ' +
          'There is no token exchange - the bot token is static.',
        cli: 'node scripts/telegram-social.mjs auth',
      },
    ],
    commonFailures: [
      {
        symptom: 'Publishing returns "Unauthorized".',
        cause: 'The bot token is wrong or was revoked.',
        fix: 'Get a fresh token from @BotFather (/token), update TELEGRAM_BOT_TOKEN, and re-run the auth check.',
      },
      {
        symptom: 'Publishing returns "chat not found" or "not enough rights".',
        cause: 'The channel id is wrong, or the bot is not an admin with Post Messages.',
        fix: 'Confirm TELEGRAM_CHANNEL_ID and add the bot as a channel administrator with posting rights.',
      },
    ],
  },

  discord: {
    portalUrl: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks',
    appToCreate: 'an Incoming Webhook on the target channel',
    productsToAdd: [],
    scopes: [],
    steps: [
      {
        title: 'Create a channel webhook',
        detail:
          'In your Discord server, open the target channel\'s settings -> Integrations -> Webhooks -> New Webhook. ' +
          'Name it (e.g. pendpost) and pick the channel it posts to.',
      },
      {
        title: 'Copy the full webhook URL',
        detail:
          'Click "Copy Webhook URL" and copy the ENTIRE value - it ends in a long token. ' +
          'A truncated URL fails with "Invalid Webhook Token".',
        env: 'DISCORD_WEBHOOK_URL',
      },
      {
        title: 'Confirm the connection',
        detail:
          'Run the CLI below to verify the webhook resolves. There is no OAuth and no token to mint - the URL is the credential.',
        cli: 'node scripts/discord-social.mjs auth',
      },
    ],
    commonFailures: [
      {
        symptom: 'Publishing returns "Invalid Webhook Token".',
        cause: 'The webhook URL was copied incompletely, or the webhook was deleted.',
        fix: 'Recreate or re-copy the full webhook URL (Channel -> Integrations -> Webhooks), update DISCORD_WEBHOOK_URL, and re-run the auth check.',
      },
      {
        symptom: 'Posts 404 after working before.',
        cause: 'The webhook (or its channel) was deleted in Discord.',
        fix: 'Create a new webhook on the channel and update DISCORD_WEBHOOK_URL.',
      },
    ],
  },

  reddit: {
    portalUrl: 'https://www.reddit.com/prefs/apps',
    appToCreate: 'a "script" type app under your Reddit account',
    productsToAdd: [],
    scopes: ['submit', 'identity'],
    steps: [
      {
        title: 'Create a script app',
        detail:
          'Sign in to Reddit, open the apps page, and click "create another app". ' +
          'Choose the "script" type, give it a name, and set the redirect uri to http://localhost:8088 (unused by a script app but required). ' +
          'The id under the app name is your client id; the "secret" field is your client secret.',
        env: 'REDDIT_CLIENT_ID',
      },
      {
        title: 'Record the client secret',
        detail: 'Copy the secret shown next to the app and store it. Treat it like a password.',
        env: 'REDDIT_CLIENT_SECRET',
      },
      {
        title: 'Set the posting account credentials',
        detail:
          'A script app authenticates as the Reddit account that owns it, using a password grant. ' +
          'Set the username and password of that account. Use a dedicated posting account, not a shared admin login.',
        env: 'REDDIT_USERNAME',
      },
      {
        title: 'Pick the target subreddit',
        detail:
          'Set the subreddit you publish to (without the r/ prefix). The account must have permission to post there, ' +
          'and the subreddit rules must allow the kind of content you send.',
        env: 'REDDIT_SUBREDDIT',
      },
      {
        title: 'Confirm the connection',
        detail:
          'Run the CLI below. It mints a short-lived token with the password grant and reads your identity back. ' +
          'Note the API free tier is non-commercial and rate limited; high-volume or commercial use needs an approved plan.',
        cli: 'node scripts/reddit-social.mjs auth',
      },
    ],
    commonFailures: [
      {
        symptom: 'auth returns "401 Unauthorized".',
        cause: 'The client id/secret pair is wrong, or the app is not a "script" type.',
        fix: 'Recreate the app as a "script" type and copy the id (under the name) and secret exactly into REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET.',
      },
      {
        symptom: 'auth returns "invalid_grant".',
        cause: 'The account username or password is wrong, or the account has two-factor login enabled.',
        fix: 'Check REDDIT_USERNAME / REDDIT_PASSWORD. Password grant does not support 2FA accounts; use a posting account without 2FA.',
      },
      {
        symptom: 'Publishing returns "SUBREDDIT_NOTALLOWED" or a rules error.',
        cause: 'The account cannot post to that subreddit, or the content breaks subreddit rules.',
        fix: 'Confirm REDDIT_SUBREDDIT, the account has posting access there, and the post matches the subreddit rules.',
      },
    ],
  },

  pinterest: {
    portalUrl: 'https://developers.pinterest.com/apps/',
    appToCreate: 'a Pinterest developer app with the v5 API enabled',
    productsToAdd: [],
    scopes: ['boards:read', 'pins:read', 'pins:write'],
    steps: [
      {
        title: 'Create a developer app',
        detail:
          'Open the Pinterest developer portal and create an app. New apps start with Trial access, ' +
          'which can post only to the app owner\'s own account; Standard access (a separate review) is needed for broader use. ' +
          'Trial access is enough to publish to your own boards.',
        env: 'PINTEREST_APP_ID',
      },
      {
        title: 'Record the app secret',
        detail: 'Copy the app secret from the app settings and store it. It is used as HTTP Basic auth on the token endpoint.',
        env: 'PINTEREST_APP_SECRET',
      },
      {
        title: 'Add the redirect uri',
        detail:
          'In the app settings, add the redirect uri exactly: http://127.0.0.1:8088/oauth/pinterest/callback . ' +
          'The auth command runs a local loopback server on that address to receive the authorization code.',
      },
      {
        title: 'Pick the target board',
        detail:
          'Choose the board pins are published to and record its id. The auth command can list your boards after you connect.',
        env: 'PINTEREST_BOARD_ID',
      },
      {
        title: 'Authorize',
        detail:
          'Run the CLI below. It opens the consent screen, exchanges the code for an access + refresh token, ' +
          'and stores the expiry. The access token is short-lived and is refreshed automatically before it expires.',
        cli: 'node scripts/pinterest-social.mjs auth',
      },
    ],
    commonFailures: [
      {
        symptom: 'The consent screen rejects the redirect uri.',
        cause: 'The redirect uri in the app settings does not match the loopback address exactly.',
        fix: 'Add http://127.0.0.1:8088/oauth/pinterest/callback to the app, with no trailing slash difference, and retry.',
      },
      {
        symptom: 'Publishing returns a 403 about access level.',
        cause: 'The app is in Trial access and is targeting an account other than the app owner.',
        fix: 'Publish to the app owner\'s own boards while in Trial, or apply for Standard access to post more broadly.',
      },
      {
        symptom: 'Posting fails with an expired-token error.',
        cause: 'The stored refresh token was revoked or rotated out.',
        fix: 'Re-run the auth command to mint a fresh access + refresh token pair.',
      },
    ],
  },

  tiktok: {
    portalUrl: 'https://developers.tiktok.com/apps/',
    appToCreate: 'a TikTok developer app with Login Kit and the Content Posting API',
    productsToAdd: ['Login Kit', 'Content Posting API'],
    scopes: ['user.info.basic', 'video.upload', 'video.publish'],
    steps: [
      {
        title: 'Create a developer app',
        detail:
          'Open the TikTok developer portal and create an app. Add the Login Kit and Content Posting API products. ' +
          'Copy the client key and client secret from the app credentials.',
        env: 'TIKTOK_CLIENT_KEY',
      },
      {
        title: 'Record the client secret',
        detail: 'Copy the client secret and store it. It is used on the token exchange and refresh calls.',
        env: 'TIKTOK_CLIENT_SECRET',
      },
      {
        title: 'Add the redirect uri',
        detail:
          'In the app settings, register the redirect uri exactly: http://127.0.0.1:8088/oauth/tiktok/callback . ' +
          'The auth command runs a local loopback server there to receive the authorization code.',
        env: 'TIKTOK_REDIRECT_URI',
      },
      {
        title: 'Authorize',
        detail:
          'Run the CLI below. It opens the consent screen for the user.info.basic, video.upload, and video.publish scopes, ' +
          'exchanges the code, and stores the access + refresh tokens with their expiry. The access token is refreshed automatically.',
        cli: 'node scripts/tiktok-social.mjs auth',
      },
      {
        title: 'Note the audit gate',
        detail:
          'Until your app passes TikTok content-posting audit, posts are restricted to SELF_ONLY (visible only to the posting account). ' +
          'Submit the app for audit to publish publicly.',
      },
    ],
    commonFailures: [
      {
        symptom: 'The consent screen rejects the redirect uri.',
        cause: 'The redirect uri in the app settings does not match the loopback address used by the auth command.',
        fix: 'Register http://127.0.0.1:8088/oauth/tiktok/callback in the app and set TIKTOK_REDIRECT_URI to the same value.',
      },
      {
        symptom: 'A scope error during authorization.',
        cause: 'The app does not have the Content Posting API or the requested scopes approved.',
        fix: 'Add the Content Posting API product and request the video.upload and video.publish scopes for the app.',
      },
      {
        symptom: 'Posts publish but are not publicly visible.',
        cause: 'The app has not passed content-posting audit, so posts are forced to SELF_ONLY.',
        fix: 'Submit the app for TikTok audit; until then expect SELF_ONLY visibility.',
      },
    ],
  },
  mastodon: {
    portalUrl: 'https://joinmastodon.org/servers',
    appToCreate: 'an application under your account\'s Preferences > Development (no developer program, no review)',
    productsToAdd: [],
    scopes: ['read', 'write:statuses', 'write:media'],
    steps: [
      {
        title: 'Pick your instance',
        detail:
          'Mastodon is federated: your account lives on ONE instance (mastodon.social, your own server, ...) and the engine talks to that '
          + 'instance\'s API directly. Record its base URL, e.g. https://mastodon.social .',
        env: 'MASTODON_INSTANCE_URL',
      },
      {
        title: 'Create an application',
        detail:
          'Log in to the instance in a browser and open Preferences > Development > New application. Name it (e.g. pendpost), grant the '
          + 'read, write:statuses and write:media scopes, and save. No callback URL is needed - the engine uses the app\'s own access token.',
      },
      {
        title: 'Copy the access token',
        detail: 'Open the application you just created and copy "Your access token" - a static token that never expires unless you regenerate it.',
        env: 'MASTODON_ACCESS_TOKEN',
      },
      {
        title: 'Validate',
        detail: 'Run the CLI below. It calls verify_credentials, confirms the token authenticates, and records your @handle for the account link.',
        cli: 'node scripts/mastodon-social.mjs auth',
      },
    ],
    commonFailures: [
      {
        symptom: 'HTTP 401 on auth or publish.',
        cause: 'The token was regenerated on the instance, or it belongs to a different instance than MASTODON_INSTANCE_URL.',
        fix: 'Confirm the instance URL matches where the app was created, regenerate the token there, and reconnect.',
      },
      {
        symptom: 'HTTP 422 on publish for a long post.',
        cause: 'The instance caps status length (500 chars by default; instance-configurable).',
        fix: 'Shorten the caption (or the mastodonCaption override) below the instance cap.',
      },
      {
        symptom: 'Media posts fail while text posts work.',
        cause: 'The application is missing the write:media scope.',
        fix: 'Recreate the application with read, write:statuses AND write:media, then reconnect with the new token.',
      },
    ],
  },
  wordpress: {
    portalUrl: 'https://wordpress.org/documentation/article/application-passwords/',
    appToCreate: 'an application password on the posting user (no app, no OAuth, no review)',
    productsToAdd: [],
    scopes: [],
    steps: [
      {
        title: 'Record the site URL',
        detail:
          'The engine talks to the site\'s own REST API at <site>/wp-json/wp/v2 - enabled by default on WordPress 5.6+. '
          + 'Record the site root, e.g. https://blog.example.com .',
        env: 'WORDPRESS_SITE_URL',
      },
      {
        title: 'Pick the posting user',
        detail: 'Posts publish as this user, so use an Author/Editor account you control. Record its username (login name, not the display name).',
        env: 'WORDPRESS_USERNAME',
      },
      {
        title: 'Create an application password',
        detail:
          'In wp-admin open Users > Profile > Application Passwords, name it (e.g. pendpost) and create it. Copy the generated password '
          + 'immediately - WordPress shows it once. Spaces in it are fine (they are part of the display format and accepted verbatim).',
        env: 'WORDPRESS_APP_PASSWORD',
      },
      {
        title: 'Validate',
        detail: 'Run the CLI below. It calls /users/me and confirms the account can publish posts.',
        cli: 'node scripts/wordpress-social.mjs auth',
      },
    ],
    commonFailures: [
      {
        symptom: 'HTTP 401 with rest_cannot_access or a login error.',
        cause: 'Application passwords are disabled (some security plugins turn them off) or the site forces basic-auth off over HTTP.',
        fix: 'Serve the site over HTTPS, re-enable application passwords in the security plugin, and mint a fresh password.',
      },
      {
        symptom: 'HTTP 403 on publish while auth succeeds.',
        cause: 'The posting user\'s role cannot publish (Contributor drafts only).',
        fix: 'Give the user the Author role or higher.',
      },
      {
        symptom: 'Posts publish with broken formatting.',
        cause: 'The markdown body uses constructs outside the engine\'s documented subset (lib/markdown.mjs).',
        fix: 'Stick to the subset (headings, lists, links, emphasis, code, quotes, images) - or paste pre-rendered HTML into the body.',
      },
    ],
  },
  ghost: {
    portalUrl: 'https://ghost.org/docs/admin-api/',
    appToCreate: 'a custom integration under Settings > Integrations (no review)',
    productsToAdd: [],
    scopes: [],
    steps: [
      {
        title: 'Record the site URL',
        detail: 'The engine talks to the Admin API at <site>/ghost/api/admin . Record the publication\'s root URL, e.g. https://blog.example.com .',
        env: 'GHOST_SITE_URL',
      },
      {
        title: 'Create a custom integration',
        detail:
          'In Ghost admin open Settings > Integrations > Add custom integration, name it (e.g. pendpost) and save. '
          + 'Copy the ADMIN API key - the long id:secret pair (the Content API key is read-only and not enough).',
        env: 'GHOST_ADMIN_API_KEY',
      },
      {
        title: 'Validate',
        detail: 'Run the CLI below. It mints a short-lived JWT from the key and reads the site record.',
        cli: 'node scripts/ghost-social.mjs auth',
      },
      {
        title: 'Newsletter opt-in (optional)',
        detail:
          'A post with "also send as newsletter" enabled emails your members on publish, via the first ACTIVE newsletter. '
          + 'Ghost only sends that email on the draft-to-published transition - the engine handles this, but the flag cannot be re-fired later.',
      },
    ],
    commonFailures: [
      {
        symptom: 'HTTP 401 UNAUTHORIZED on every call.',
        cause: 'The Content API key was copied instead of the Admin API key, or the integration was deleted.',
        fix: 'Copy the ADMIN API key (id:secret) from the custom integration and reconnect.',
      },
      {
        symptom: 'Publish succeeds but no newsletter email arrives.',
        cause: 'No active newsletter exists, members are zero, or the post was already published without the flag.',
        fix: 'Activate a newsletter under Settings > Newsletters and re-check member signups; the email only fires on first publish.',
      },
    ],
  },
  nostr: {
    portalUrl: 'https://nostr.com',
    appToCreate: 'nothing - Nostr has no accounts, only a keypair you mint yourself',
    productsToAdd: [],
    scopes: [],
    steps: [
      {
        title: 'Mint (or import) a keypair',
        detail:
          'Run the keygen CLI below to mint a fresh nsec/npub pair, or reuse an existing nsec from any Nostr client. '
          + 'The nsec IS the account - anyone holding it can post as you, so treat it like a password.',
        cli: 'node scripts/nostr-social.mjs keygen --save',
        env: 'NOSTR_PRIVATE_KEY',
      },
      {
        title: 'Choose relays',
        detail:
          'Posts are published to every relay in the comma-separated list; one acceptance counts as published. '
          + 'Public defaults like wss://relay.damus.io,wss://nos.lol work; a private relay works too.',
        env: 'NOSTR_RELAYS',
      },
      {
        title: 'Validate',
        detail: 'Run the CLI below. It derives your npub and proves at least one relay is reachable.',
        cli: 'node scripts/nostr-social.mjs auth',
      },
      {
        title: 'Know the lane\'s shape',
        detail:
          'Nostr notes are TEXT ONLY here - there is no media hosting in the protocol itself, so a media post publishes its caption '
          + 'and logs a warning. Deletion is a request (NIP-09) that relays may ignore.',
      },
    ],
    commonFailures: [
      {
        symptom: 'auth reports no reachable relay.',
        cause: 'The relay URLs are wrong (must be ws:// or wss://) or the relay is down/blocking writes.',
        fix: 'Test with a known-good public relay (wss://relay.damus.io) and re-run auth.',
      },
      {
        symptom: 'The engine refuses to start with a WebSocket error.',
        cause: 'Node is older than 22, so the global WebSocket client is missing.',
        fix: 'Upgrade Node to 22+ for the nostr lane (the other lanes run on 20).',
      },
    ],
  },
  gbp: {
    portalUrl: 'https://console.cloud.google.com/apis/credentials',
    appToCreate: 'a Google Cloud OAuth client (Desktop/Web) with the Business Profile APIs enabled',
    productsToAdd: ['My Business Account Management API', 'My Business Business Information API', 'Google My Business API (v4)'],
    scopes: ['https://www.googleapis.com/auth/business.manage'],
    steps: [
      {
        title: 'Request Business Profile API access',
        detail:
          'Google gates the Business Profile APIs behind a per-project access request (the form at '
          + 'https://developers.google.com/my-business/content/prereqs). Until approved, every call returns 403 - the lane stays beta.',
      },
      {
        title: 'Create the OAuth client',
        detail:
          'In the Cloud console create OAuth credentials, enable the Business Profile APIs above, and register the loopback redirect '
          + 'http://127.0.0.1:8088/oauth/gbp/callback . Copy the client id and secret.',
        env: 'GBP_CLIENT_ID',
      },
      {
        title: 'Authorize',
        detail:
          'Run the CLI below. It opens the consent screen for business.manage, exchanges the code, stores the tokens, and - once the API '
          + 'access is approved - prints your account and location ids as candidates for the two identifier fields.',
        cli: 'node scripts/gbp-social.mjs auth',
      },
      {
        title: 'Set the target location',
        detail: 'Set GBP_ACCOUNT_ID and GBP_LOCATION_ID to the numeric ids of the verified business location posts should appear on.',
        env: 'GBP_LOCATION_ID',
      },
    ],
    commonFailures: [
      {
        symptom: 'Every API call returns 403 after a successful consent.',
        cause: 'The Cloud project has not been approved for the Business Profile APIs yet.',
        fix: 'Submit the access request form and wait for approval; the OAuth token itself is fine.',
      },
      {
        symptom: 'Publish fails with a location error.',
        cause: 'GBP_ACCOUNT_ID/GBP_LOCATION_ID are missing, or the location is not verified/owned by the authorized account.',
        fix: 'Run auth to list candidates, verify the location in the Business Profile manager, and set both ids.',
      },
      {
        symptom: 'The post is created but never becomes visible.',
        cause: 'Google reviews local posts; REJECTED state means a content-policy hit.',
        fix: 'Check verify for the post state and adjust the content (no phone numbers in the summary, policy-safe imagery).',
      },
    ],
  },
};
