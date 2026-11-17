package com.chapterly.provider;

import org.springframework.stereotype.Component;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Builds SSML documents with all user text safely XML-escaped. */
@Component
public class SsmlBuilder {

    private static final Pattern VOICE_LOCALE = Pattern.compile("^([a-z]{2,3}-[A-Z]{2})-");

    public String build(String voice, String text) {
        return "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xml:lang=\""
                + escape(languageOf(voice)) + "\">"
                + "<voice name=\"" + escape(voice) + "\">"
                + escape(text)
                + "</voice></speak>";
    }

    /** "en-GB-RyanNeural" -> "en-GB"; falls back to "en-US". */
    static String languageOf(String voice) {
        Matcher m = VOICE_LOCALE.matcher(voice == null ? "" : voice);
        return m.find() ? m.group(1) : "en-US";
    }

    public static String escape(String s) {
        StringBuilder out = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&' -> out.append("&amp;");
                case '<' -> out.append("&lt;");
                case '>' -> out.append("&gt;");
                case '"' -> out.append("&quot;");
                case '\'' -> out.append("&apos;");
                default -> out.append(c);
            }
        }
        return out.toString();
    }
}
