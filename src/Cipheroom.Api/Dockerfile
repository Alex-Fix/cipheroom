# Build context: repo root (needs global.json, Directory.*.props).
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
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
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled
WORKDIR /app
COPY --from=build /app .
COPY --from=build --chown=$APP_UID:$APP_UID /data /data
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER $APP_UID
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["dotnet", "Cipheroom.Api.dll", "--health"]
ENTRYPOINT ["dotnet", "Cipheroom.Api.dll"]
