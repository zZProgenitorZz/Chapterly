package com.chapterly.provider;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SsmlBuilderTest {

    private final SsmlBuilder builder = new SsmlBuilder();

    @Test
    void escapesAmpersand() {
        assertThat(SsmlBuilder.escape("Tom & Jerry")).isEqualTo("Tom &amp; Jerry");
    }

    @Test
    void escapesAngleBrackets() {
        assertThat(SsmlBuilder.escape("<b>bold</b>")).isEqualTo("&lt;b&gt;bold&lt;/b&gt;");
    }

    @Test
    void escapesQuotes() {
        assertThat(SsmlBuilder.escape("\"Hi,\" she said. 'Bye.'"))
                .isEqualTo("&quot;Hi,&quot; she said. &apos;Bye.&apos;");
    }

    @Test
    void leavesPlainTextAlone() {
        assertThat(SsmlBuilder.escape("Hello, this is Brian.")).isEqualTo("Hello, this is Brian.");
    }

    @Test
    void escapesAmpersandOnlyOnce() {
        assertThat(SsmlBuilder.escape("&amp;")).isEqualTo("&amp;amp;");
    }

    @Test
    void textCannotBreakOutOfVoiceElement() {
        String ssml = builder.build("en-US-BrianNeural", "</voice><voice name='evil'>hi");

        assertThat(ssml)
                .contains("<voice name=\"en-US-BrianNeural\">")
                .contains("&lt;/voice&gt;&lt;voice name=&apos;evil&apos;&gt;hi")
                .endsWith("</voice></speak>");
    }
}
