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
};
