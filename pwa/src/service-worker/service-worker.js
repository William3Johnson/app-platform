import { precacheAndRoute, matchPrecache, precache } from 'workbox-precaching'
import { registerRoute, setDefaultHandler } from 'workbox-routing'
import {
    NetworkFirst,
    StaleWhileRevalidate,
    Strategy,
} from 'workbox-strategies'
import { swMsgs } from '../lib/constants.js'
import {
    startRecording,
    completeRecording,
    handleRecordedRequest,
    shouldRequestBeRecorded,
} from './recording-mode.js'
import {
    urlMeetsAppShellCachingCriteria,
    createDB,
    removeUnusedCaches,
    setUpKillSwitchServiceWorker,
    getClientsInfo,
    claimClients,
} from './utils.js'

export function setUpServiceWorker() {
    const pwaEnabled = process.env.REACT_APP_DHIS2_APP_PWA_ENABLED === 'true'
    if (!pwaEnabled) {
        // Install 'killswitch' service worker and refresh page to clear
        // rogue service workers. App should then unregister SW
        setUpKillSwitchServiceWorker()
        return
    }

    // Misc setup

    // Disable verbose logs
    // TODO: control with env var
    self.__WB_DISABLE_DEV_LOGS = true

    // Globals (Note: global state resets each time SW goes idle)

    // Tracks recording states for multiple clients to handle multiple windows
    // recording simultaneously
    self.clientRecordingStates = {}

    // Local constants

    const PRODUCTION_ENV = process.env.NODE_ENV === 'production'
    const fileExtensionRegexp = new RegExp('/[^/?]+\\.[^/]+$')

    // Workbox routes

    // Only precache in production mode to enable easier app development.
    // In development, static assets are handled by 'network first' strategy
    // and will be kept up-to-date.
    if (PRODUCTION_ENV) {
        // Precache all of the assets generated by your build process.
        // Their URLs are injected into the manifest variable below.
        // This variable must be present somewhere in your service worker file,
        // even if you decide not to use precaching. See https://cra.link/PWA.
        // Includes all built assets and index.html
        const precacheManifest = self.__WB_MANIFEST || []

        // Extract index.html from the manifest to precache, then route
        // in a custom way
        const indexHtmlManifestEntry = precacheManifest.find(({ url }) =>
            url.endsWith('index.html')
        )
        precache([indexHtmlManifestEntry])

        // Custom strategy for handling app navigation, specifically to allow
        // navigations to redirect to the login page while online if the
        // user is unauthenticated. Fixes showing the app shell login dialog
        // in production if a user is online and unauthenticated.
        // Uses app-shell style routing to route navigations to index.html.
        const navigationRouteMatcher = ({ request, url }) => {
            // If this isn't a navigation, skip.
            if (request.mode !== 'navigate') {
                return false
            }

            // If this is a URL that starts with /_, skip.
            if (url.pathname.startsWith('/_')) {
                return false
            }

            // If this looks like a URL for a resource, because it contains
            // a file extension, skip (unless it's index.html)
            if (
                fileExtensionRegexp.test(url.pathname) &&
                !url.pathname.endsWith('index.html')
            ) {
                return false
            }

            // Return true to signal that we want to use the handler.
            return true
        }
        const indexUrl = process.env.PUBLIC_URL + '/index.html'
        const navigationRouteHandler = ({ request }) => {
            return fetch(request)
                .then((response) => {
                    if (response.type === 'opaqueredirect') {
                        // It's sending a redirect to the login page. Return
                        // that to the client
                        return response
                    }

                    // Otherwise return precached index.html
                    return matchPrecache(indexUrl)
                })
                .catch(() => {
                    // Request failed (maybe offline). Return cached response
                    return matchPrecache(indexUrl)
                })
        }
        registerRoute(navigationRouteMatcher, navigationRouteHandler)

        // Handle the rest of files in the manifest
        const restOfManifest = precacheManifest.filter(
            (e) => e !== indexHtmlManifestEntry
        )
        precacheAndRoute(restOfManifest)

        // Similar to above; manifest injection from `workbox-build`
        // Precaches all assets in the shell's build folder except in `static`
        // (which CRA's workbox-webpack-plugin handle smartly).
        // Additional files to precache can be added using the
        // `additionalManifestEntries` option in d2.config.js; see the docs and
        // 'injectPrecacheManifest.js' in the CLI package.
        // '[]' fallback prevents an error when switching pwa enabled to disabled
        precacheAndRoute(self.__WB_BUILD_MANIFEST || [])
    }

    // Request handler during recording mode: ALL requests are cached
    // Handling routing: https://developers.google.com/web/tools/workbox/modules/workbox-routing#matching_and_handling_in_routes
    registerRoute(shouldRequestBeRecorded, handleRecordedRequest)

    // If not recording, fall through to default caching strategies for app
    // shell:
    // SWR strategy for static assets that can't be precached.
    // (Skip in development environments)
    registerRoute(
        ({ url }) =>
            PRODUCTION_ENV &&
            urlMeetsAppShellCachingCriteria(url) &&
            fileExtensionRegexp.test(url.pathname),
        new StaleWhileRevalidate({ cacheName: 'other-assets' })
    )

    // Network-first caching by default
    registerRoute(
        ({ url }) => urlMeetsAppShellCachingCriteria(url),
        new NetworkFirst({ cacheName: 'app-shell' })
    )

    // Strategy for all other requests: try cache if network fails,
    // but don't add anything to cache
    class NetworkAndTryCache extends Strategy {
        _handle(request, handler) {
            return handler.fetch(request).catch((fetchErr) => {
                // handler.cacheMatch doesn't work b/c it doesn't check all caches
                return caches.match(request).then((res) => {
                    // If not found in cache, throw original fetchErr
                    // (if there's a cache err, that will be returned)
                    if (!res) {
                        throw fetchErr
                    }
                    return res
                })
            })
        }
    }
    // Use fallback strategy as default
    setDefaultHandler(new NetworkAndTryCache())

    // Service Worker event handlers

    self.addEventListener('message', (event) => {
        if (!event.data) {
            return
        }

        if (event.data.type === swMsgs.getClientsInfo) {
            getClientsInfo(event)
        }

        // Can be used upon first SW activation
        if (event.data.type === swMsgs.claimClients) {
            claimClients()
        }

        // This allows the web app to trigger skipWaiting via
        // registration.waiting.postMessage({type: 'SKIP_WAITING'})
        if (event.data.type === swMsgs.skipWaiting) {
            self.skipWaiting()
        }

        if (event.data.type === swMsgs.startRecording) {
            startRecording(event)
        }

        if (event.data.type === swMsgs.completeRecording) {
            completeRecording(event.source.id) // same as FetchEvent.clientId
        }
    })

    // Open DB on activation
    self.addEventListener('activate', (event) => {
        event.waitUntil(createDB().then(removeUnusedCaches))
    })
}
