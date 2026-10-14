package de.dienst.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

/**
 * A thin shell around the Dienstplan web app. It remembers the address of the server, shows the web app in a WebView
 * and, when the phone touches an NFC tag at the hotel, opens the punch screen of that tag
 * ({@code https://<server>/nfc?t=<token>}). Nothing about the punch is decided here: the server checks the login,
 * the tag and whether the person works at the hotel.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "dienst";
    private static final String KEY_SERVER = "server";
    private static final int MENU_RELOAD = 1;
    private static final int MENU_SERVER = 2;

    private WebView web;
    private String server;
    /** a tag address waiting for the person to confirm a new server */
    private boolean asking;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(web);
        configure(web);
        server = prefs().getString(KEY_SERVER, null);
        if (state != null) {
            web.restoreState(state);
            return;
        }
        if (!handleIntent(getIntent())) {
            if (server != null) web.loadUrl(server + "/");
            else askServer(null);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!handleIntent(intent) && server == null) askServer(null);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, MENU_RELOAD, 0, "Neu laden").setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        menu.add(0, MENU_SERVER, 1, "Server ändern").setShowAsAction(MenuItem.SHOW_AS_ACTION_NEVER);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == MENU_RELOAD) {
            if (server != null) web.loadUrl(server + "/");
            else askServer(null);
            return true;
        }
        if (item.getItemId() == MENU_SERVER) {
            askServer(server);
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void configure(WebView w) {
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (server != null && TagLink.isUnder(server, url)) return false;
                // anything outside the Dienstplan server (a link in an announcement, say) opens in the browser
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Link kann nicht geöffnet werden.", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                view.loadDataWithBaseURL(
                        null,
                        "<meta name='viewport' content='width=device-width'><body style='font-family:sans-serif;padding:24px'>"
                                + "<h2>Server nicht erreichbar</h2>"
                                + "<p>Bitte prüfe die Internet- bzw. WLAN-Verbindung und lade die Seite über das Menü neu. "
                                + "Ist die Server-Adresse falsch, ändere sie im Menü unter „Server ändern“.</p></body>",
                        "text/html",
                        "UTF-8",
                        null);
            }
        });
    }

    /** Handles a tapped tag or a link to one. Returns true when the intent carried an address. */
    private boolean handleIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return false;
        TagLink link = TagLink.parse(intent.getDataString());
        if (link == null) {
            Toast.makeText(this, "Das ist kein Dienstplan-NFC-Tag.", Toast.LENGTH_LONG).show();
            return false;
        }
        if (server == null) {
            confirmNewServer(link);
        } else if (TagLink.sameOrigin(server, link.origin)) {
            web.loadUrl(link.url);
        } else {
            Toast.makeText(this, "Dieser Tag gehört zu einem anderen Server (" + link.origin + ").", Toast.LENGTH_LONG).show();
            return false;
        }
        return true;
    }

    /** The first tag on a freshly installed app: ask once whether to connect to the server written on it. */
    private void confirmNewServer(final TagLink link) {
        if (asking) return;
        asking = true;
        new AlertDialog.Builder(this)
                .setTitle("Mit diesem Server verbinden?")
                .setMessage(link.origin + "\n\nNur bestätigen, wenn das die Adresse deines Hotels ist.")
                .setCancelable(false)
                .setPositiveButton("Verbinden", (d, w) -> {
                    asking = false;
                    saveServer(link.origin);
                    web.loadUrl(link.url);
                })
                .setNegativeButton("Abbrechen", (d, w) -> {
                    asking = false;
                    askServer(null);
                })
                .show();
    }

    private void saveServer(String origin) {
        server = origin;
        prefs().edit().putString(KEY_SERVER, origin).apply();
    }

    /** Asks for the address of the Dienstplan server (first start, or "Server ändern"). */
    private void askServer(String current) {
        if (asking) return;
        asking = true;
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("dienst.example.com");
        if (current != null) input.setText(current);
        new AlertDialog.Builder(this)
                .setTitle("Server-Adresse")
                .setMessage("Gib die Adresse ein, unter der dein Team die Dienstplan-App öffnet.")
                .setView(input)
                .setCancelable(current != null)
                .setPositiveButton("Verbinden", (d, w) -> {
                    asking = false;
                    String origin = TagLink.normalizeServer(input.getText().toString());
                    if (origin == null) {
                        Toast.makeText(this, "Diese Adresse ist ungültig.", Toast.LENGTH_LONG).show();
                        askServer(current);
                        return;
                    }
                    if (!TagLink.sameOrigin(origin, server)) {
                        // another server means another login: forget the old session
                        CookieManager.getInstance().removeAllCookies(null);
                        web.clearHistory();
                    }
                    saveServer(origin);
                    web.loadUrl(origin + "/");
                })
                .setNegativeButton("Abbrechen", (d, w) -> asking = false)
                .setOnCancelListener(d -> asking = false)
                .show();
    }
}
