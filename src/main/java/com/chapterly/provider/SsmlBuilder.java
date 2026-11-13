package com.chapterly.provider;

import org.springframework.stereotype.Component;

/** Builds SSML documents with all user text safely XML-escaped. */
@Component
public class SsmlBuilder {

    public String build(String voice, String text) {
        return "<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xml:lang=\"en-US\">"
                + "<voice name=\"" + escape(voice) + "\">"
                + escape(text)
                + "</voice></speak>";
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
