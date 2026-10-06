# Build context: repo root (needs Directory.Build.props).
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Directory.Build.props ./
COPY src/server/Cipheroom.Api/Cipheroom.Api.csproj src/server/Cipheroom.Api/
RUN dotnet restore src/server/Cipheroom.Api/Cipheroom.Api.csproj
COPY src/server/Cipheroom.Api/ src/server/Cipheroom.Api/
RUN dotnet publish src/server/Cipheroom.Api/Cipheroom.Api.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER app
ENTRYPOINT ["dotnet", "Cipheroom.Api.dll"]
