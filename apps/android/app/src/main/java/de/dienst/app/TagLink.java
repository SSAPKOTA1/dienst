package de.dienst.app;

import java.net.URI;
import java.util.Locale;

/**
 * The web address written on an NFC tag: {@code https://<server>/nfc?t=<token>}. Pure Java so it can be unit tested
 * on the JVM. The app opens such an address in its WebView, so what counts as a valid one is security relevant.
 */
public final class TagLink {
    /** scheme://host[:port] without a trailing slash, lower case */
    public final String origin;
    /** the address to load: origin + /nfc?t=... */
    public final String url;

    private TagLink(String origin, String url) {
        this.origin = origin;
        this.url = url;
    }

    /** Returns the link, or null when the text is not a tag address (wrong scheme, path, or no token). */
    public static TagLink parse(String text) {
        if (text == null) return null;
        URI u;
        try {
            u = new URI(text.trim());
        } catch (Exception e) {
            return null;
        }
        String origin = originOf(u);
        if (origin == null) return null;
        if (u.getRawUserInfo() != null || u.getRawFragment() != null) return null;
        if (!"/nfc".equals(u.getRawPath())) return null;
        String token = queryParam(u.getRawQuery(), "t");
        if (token == null || token.length() < 10 || token.length() > 200 || !token.matches("[A-Za-z0-9_-]+")) {
            return null;
        }
        return new TagLink(origin, origin + "/nfc?t=" + token);
    }

    /** scheme://host[:port] of an http(s) address with a host, else null. */
    public static String originOf(URI u) {
        String scheme = u.getScheme();
        String host = u.getHost();
        if (scheme == null || host == null) return null;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) return null;
        int port = u.getPort();
        boolean standard = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + (standard ? "" : ":" + port);
    }

    /** Origin of a web address typed by a person ("hotel.example.com" means https), or null when unusable. */
    public static String normalizeServer(String text) {
        if (text == null) return null;
        String s = text.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "https://" + s;
        try {
            URI u = new URI(s);
            if (u.getRawUserInfo() != null) return null;
            return originOf(u);
        } catch (Exception e) {
            return null;
        }
    }

    /** True when both addresses have the same scheme, host and port. */
    public static boolean sameOrigin(String a, String b) {
        return a != null && b != null && a.equalsIgnoreCase(b);
    }

    /** True when the address belongs to the given origin. */
    public static boolean isUnder(String origin, String address) {
        try {
            return sameOrigin(origin, originOf(new URI(address)));
        } catch (Exception e) {
            return false;
        }
    }

    private static String queryParam(String query, String name) {
        if (query == null) return null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(name)) return pair.substring(eq + 1);
        }
        return null;
    }
}
