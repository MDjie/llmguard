FROM maven:3.9.12-eclipse-temurin-21-alpine AS build
RUN apk add --no-cache gcompat
WORKDIR /workspace
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp dependency:go-offline
COPY src src
RUN --mount=type=cache,target=/root/.m2 mvn -B -ntp verify

FROM scratch
COPY --from=build /workspace/target/guardllm-java-sdk-*.jar /guardllm-java-sdk.jar
