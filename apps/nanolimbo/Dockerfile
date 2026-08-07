FROM eclipse-temurin:21-jre-alpine

WORKDIR /app

RUN apk add --no-cache curl \
    && curl -L -o nanolimbo.jar https://github.com/Nan1t/NanoLimbo/releases/download/v1.13.0/NanoLimbo.jar

EXPOSE 25565

COPY apps/nanolimbo/settings.yml /app/settings.yml

CMD ["java", "-jar", "nanolimbo.jar"]
