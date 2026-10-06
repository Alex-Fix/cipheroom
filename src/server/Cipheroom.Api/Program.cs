using Cipheroom.Api.Hosting;
using Cipheroom.Api.Hubs;
using Cipheroom.Api.Hubs.Filters;
using Cipheroom.Application;
using Cipheroom.Application.Common.Behaviours;
using Cipheroom.Infrastructure;
using Mediator;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddApplication();
builder.Services.AddInfrastructure();
builder.Services.AddMediator((MediatorOptions options) =>
{
    // Source-generated at compile time, so the configuration must be literal here.
    options.Assemblies = [typeof(Cipheroom.Application.DependencyInjection)];
    // Scoped: handlers and FluentValidation validators resolve per hub invocation.
    options.ServiceLifetime = ServiceLifetime.Scoped;
    // Outermost first.
    options.PipelineBehaviors =
    [
        typeof(UnhandledExceptionBehaviour<,>),
        typeof(LoggingBehaviour<,>),
        typeof(ValidationBehaviour<,>),
    ];
});

builder.Services.AddOptions<HubRateLimitOptions>().BindConfiguration(HubRateLimitOptions.Section).ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddSingleton<HubRateLimitFilter>();
builder.Services.AddSignalR(o =>
{
    o.MaximumReceiveMessageSize = 64 * 1024;
    // Outermost first: reject floods before doing any work.
    o.AddFilter<HubRateLimitFilter>();
    o.AddFilter<HubExceptionFilter>();
});
builder.Services.AddTrustedForwardedHeaders(builder.Configuration);
builder.Services.AddProblemDetails();
builder.Services.AddHealthChecks();

var app = builder.Build();

app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();

app.MapHealthChecks("/healthz");
app.MapHub<RoomHub>("/hubs/room");

app.Run();

public partial class Program;
