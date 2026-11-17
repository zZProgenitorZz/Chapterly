# syntax=docker/dockerfile:1
#
# Chapterly backend image. Secrets are never part of the image: AZURE_SPEECH_KEY and
# AZURE_SPEECH_REGION come in at runtime (docker-compose env_file / environment).

# ---------- build ----------
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
COPY src ./src
# The ~/.m2 cache mount keeps downloaded dependencies between builds (BuildKit).
RUN --mount=type=cache,target=/root/.m2 \
    mvn -q -B -DskipTests package \
    && cp target/chapterly-backend-*.jar /chapterly.jar

# ---------- run ----------
FROM eclipse-temurin:21-jre
RUN groupadd --system chapterly && useradd --system --gid chapterly --no-create-home chapterly
WORKDIR /app
COPY --from=build --chown=chapterly:chapterly /chapterly.jar /app/chapterly.jar
USER chapterly
EXPOSE 8080
# Respect the container's memory limit.
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"
ENTRYPOINT ["java", "-jar", "/app/chapterly.jar"]
