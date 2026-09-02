package com.guardllm.gateway;

import io.netty.channel.ChannelOption;
import io.netty.handler.ssl.SslContextBuilder;
import java.io.File;
import javax.net.ssl.SSLException;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.netty.http.client.HttpClient;

@Configuration
class GatewayWebClientConfiguration {
    private static WebClient client(
            GuardGatewayProperties properties,
            GatewayTlsProperties tls,
            String baseUrl) throws SSLException {
        HttpClient httpClient = HttpClient.create()
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 2_000)
                .responseTimeout(properties.requestTimeout());
        if (tls.required()) {
            var context = SslContextBuilder.forClient()
                    .trustManager(new File(tls.trustCertificate()))
                    .keyManager(new File(tls.clientCertificate()), new File(tls.clientPrivateKey()))
                    .build();
            httpClient = httpClient.secure(spec -> spec.sslContext(context)
                    .handshakeTimeout(properties.requestTimeout()));
        }
        return WebClient.builder().baseUrl(baseUrl)
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .codecs(configurer -> configurer.defaultCodecs().maxInMemorySize(2 * 1024 * 1024))
                .build();
    }

    @Bean
    @Qualifier("guardWebClient")
    WebClient guardWebClient(GuardGatewayProperties properties, GatewayTlsProperties tls)
            throws SSLException {
        return client(properties, tls, properties.guardBaseUrl().toString());
    }

    @Bean
    @Qualifier("modelWebClient")
    WebClient modelWebClient(GuardGatewayProperties properties, GatewayTlsProperties tls)
            throws SSLException {
        return client(properties, tls, properties.modelBaseUrl().toString());
    }
}
