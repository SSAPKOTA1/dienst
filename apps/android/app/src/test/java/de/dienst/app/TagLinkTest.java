package de.dienst.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TagLinkTest {
    private static final String TOKEN = "nt_abcDEF123-xyz_0123456789";

    @Test
    public void acceptsATagAddress() {
        TagLink l = TagLink.parse("https://Dienst.Example.com/nfc?t=" + TOKEN);
        assertNotNull(l);
        assertEquals("https://dienst.example.com", l.origin);
        assertEquals("https://dienst.example.com/nfc?t=" + TOKEN, l.url);
    }

    @Test
    public void keepsANonStandardPortAndDropsTheStandardOne() {
        assertEquals("http://192.168.1.50:5173", TagLink.parse("http://192.168.1.50:5173/nfc?t=" + TOKEN).origin);
        assertEquals("https://h.example", TagLink.parse("https://h.example:443/nfc?t=" + TOKEN).origin);
        assertEquals("http://h.example", TagLink.parse("http://h.example:80/nfc?t=" + TOKEN).origin);
    }

    @Test
    public void refusesWhatIsNotATagAddress() {
        assertNull(TagLink.parse(null));
        assertNull(TagLink.parse(""));
        assertNull(TagLink.parse("javascript:alert(1)"));
        assertNull(TagLink.parse("file:///nfc?t=" + TOKEN));
        assertNull(TagLink.parse("ftp://h.example/nfc?t=" + TOKEN));
        assertNull(TagLink.parse("https://h.example/other?t=" + TOKEN));
        assertNull(TagLink.parse("https://h.example/nfc/extra?t=" + TOKEN));
        assertNull(TagLink.parse("https://h.example/nfc"));
        assertNull(TagLink.parse("https://h.example/nfc?x=" + TOKEN));
        assertNull(TagLink.parse("https://h.example/nfc?t=short"));
        assertNull(TagLink.parse("https://h.example/nfc?t=" + TOKEN + "%3Cscript%3E"));
        assertNull(TagLink.parse("https://user:pw@h.example/nfc?t=" + TOKEN));
        assertNull(TagLink.parse("https://h.example/nfc?t=" + TOKEN + "#frag"));
        assertNull(TagLink.parse("https:///nfc?t=" + TOKEN));
        assertNull(TagLink.parse("not a url at all"));
    }

    @Test
    public void normalizesTheServerAddressAPersonTypes() {
        assertEquals("https://hotel.example.com", TagLink.normalizeServer("hotel.example.com"));
        assertEquals("https://hotel.example.com", TagLink.normalizeServer("  https://Hotel.Example.com/  "));
        assertEquals("https://hotel.example.com", TagLink.normalizeServer("https://hotel.example.com/some/path?x=1"));
        assertEquals("http://192.168.1.50:5173", TagLink.normalizeServer("http://192.168.1.50:5173"));
        assertNull(TagLink.normalizeServer(""));
        assertNull(TagLink.normalizeServer(null));
        assertNull(TagLink.normalizeServer("ftp://hotel.example.com"));
        assertNull(TagLink.normalizeServer("https://user@hotel.example.com"));
    }

    @Test
    public void comparesOrigins() {
        assertTrue(TagLink.sameOrigin("https://a.example", "https://A.example"));
        assertFalse(TagLink.sameOrigin("https://a.example", "http://a.example"));
        assertFalse(TagLink.sameOrigin("https://a.example", "https://a.example:8443"));
        assertFalse(TagLink.sameOrigin(null, "https://a.example"));
        assertTrue(TagLink.isUnder("https://a.example", "https://a.example/me/nfc?t=x"));
        assertFalse(TagLink.isUnder("https://a.example", "https://a.example.evil.test/"));
        assertFalse(TagLink.isUnder("https://a.example", "https://evil.test/https://a.example"));
        assertFalse(TagLink.isUnder("https://a.example", "not a url"));
    }
}
