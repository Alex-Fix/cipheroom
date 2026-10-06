# Build context: repo root (needs global.json, Directory.*.props).
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY global.json Directory.Build.props Directory.Packages.props ./
# Project files first so restore is cached until dependencies change.
COPY src/server/Cipheroom.Domain/Cipheroom.Domain.csproj src/server/Cipheroom.Domain/
COPY src/server/Cipheroom.Application/Cipheroom.Application.csproj src/server/Cipheroom.Application/
COPY src/server/Cipheroom.Infrastructure/Cipheroom.Infrastructure.csproj src/server/Cipheroom.Infrastructure/
COPY src/server/Cipheroom.Api/Cipheroom.Api.csproj src/server/Cipheroom.Api/
RUN dotnet restore src/server/Cipheroom.Api/Cipheroom.Api.csproj
COPY src/server/Cipheroom.Domain/ src/server/Cipheroom.Domain/
COPY src/server/Cipheroom.Application/ src/server/Cipheroom.Application/
COPY src/server/Cipheroom.Infrastructure/ src/server/Cipheroom.Infrastructure/
COPY src/server/Cipheroom.Api/ src/server/Cipheroom.Api/
RUN dotnet publish src/server/Cipheroom.Api/Cipheroom.Api.csproj -c Release -o /app --no-restore

# Chiseled: no shell, no package manager, non-root by default.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER $APP_UID
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["dotnet", "Cipheroom.Api.dll", "--health"]
ENTRYPOINT ["dotnet", "Cipheroom.Api.dll"]
