# Build context: repo root (needs global.json, Directory.*.props).
# Base images are pinned by digest (reproducible builds); Dependabot (.github/dependabot.yml) proposes updates.
FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:e70cdb7f80b0348f5cb85f19a8f670fca061f033d57eed12fa003d58b0e06317 AS build
WORKDIR /src
COPY global.json Directory.Build.props Directory.Packages.props ./
# Project files first so restore is cached until dependencies change.
COPY src/Cipheroom.Domain/Cipheroom.Domain.csproj src/Cipheroom.Domain/
COPY src/Cipheroom.Application/Cipheroom.Application.csproj src/Cipheroom.Application/
COPY src/Cipheroom.Infrastructure/Cipheroom.Infrastructure.csproj src/Cipheroom.Infrastructure/
COPY src/Cipheroom.Api/Cipheroom.Api.csproj src/Cipheroom.Api/
RUN dotnet restore src/Cipheroom.Api/Cipheroom.Api.csproj
COPY src/Cipheroom.Domain/ src/Cipheroom.Domain/
COPY src/Cipheroom.Application/ src/Cipheroom.Application/
COPY src/Cipheroom.Infrastructure/ src/Cipheroom.Infrastructure/
COPY src/Cipheroom.Api/ src/Cipheroom.Api/
RUN dotnet publish src/Cipheroom.Api/Cipheroom.Api.csproj -c Release -o /app --no-restore
# The usage guard's state (/data/usage.json). The chiseled image has no shell to mkdir, so the directory is made here
# and copied with the app user as owner; a new named volume mounted there inherits that ownership.
RUN mkdir -p /data

# Chiseled: no shell, no package manager, non-root by default.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled@sha256:48e51f2f6798897be7ac4e775c049ed8fe60d3190f637e1f9c9dc7513efa659c
WORKDIR /app
COPY --from=build /app .
COPY --from=build --chown=$APP_UID:$APP_UID /data /data
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER $APP_UID
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["dotnet", "Cipheroom.Api.dll", "--health"]
ENTRYPOINT ["dotnet", "Cipheroom.Api.dll"]
