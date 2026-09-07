FROM maven:3.9.12-eclipse-temurin-21-alpine AS build
RUN apk add --no-cache gcompat
WORKDIR /workspace/services/guard-gateway
COPY services/guard-gateway/pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp dependency:go-offline
COPY services/guard-gateway/src src
COPY packages/contracts/golden/gateway-v2.json /workspace/packages/contracts/golden/gateway-v2.json
COPY services/guard-gateway/probe probe
RUN javac -d target/probe probe/GatewayReadinessProbe.java
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp verify

FROM eclipse-temurin:21.0.10_7-jre-alpine
RUN addgroup -S guard && adduser -S -G guard -u 10001 guard
WORKDIR /app
COPY --from=build --chown=guard:guard /workspace/services/guard-gateway/target/guard-gateway-*.jar /app/guard-gateway.jar
COPY --from=build --chown=guard:guard /workspace/services/guard-gateway/target/probe /app/probe
USER 10001
EXPOSE 8080 9090
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/guard-gateway.jar"]
