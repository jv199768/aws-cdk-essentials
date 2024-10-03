import { App, Stack } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
const vpc = new ec2.Vpc(this, 'MyVpc', {
  maxAzs: 2, // Deploy across two availability zones
  natGateways: 1, // One NAT Gateway for outbound traffic
});
const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      securityGroupName: `ecs-fargate-sg-${appEnv}`,
    });
    ecsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');
    ecsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS traffic');
const environmentBucket = new s3.Bucket(this, 'EnvironmentBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

const ecrRepository = new ecr.Repository(this, 'MyEcrRepo', {
      repositoryName: `ecs-fargate-app-${appEnv}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

const ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      clusterName: `ecs-cluster-${appEnv}`,
    });

const taskDefinition = new ecs.FargateTaskDefinition(this, 'FargateTaskDef', {
  memoryLimitMiB: 1024, // 1 GB RAM
  cpu: 512, // 0.5 vCPU
});

// Add execution role permissions for S3 (to access env files)
taskDefinition.addToExecutionRolePolicy(new iam.PolicyStatement({
  actions: ['s3:GetObject'],
  resources: [environmentBucket.bucketArn + '/*'],
}));

// Define container using ECR image
const container = taskDefinition.addContainer('AppContainer', {
  image: ecs.ContainerImage.fromEcrRepository(ecrRepository, imageTag),
  memoryReservationMiB: 1024,
  logging: new ecs.AwsLogDriver({
    logGroup: new logs.LogGroup(this, 'AppLogGroup', {
      logGroupName: `/ecs/fargate-${appEnv}`,
      retention: logs.RetentionDays.ONE_WEEK,
    }),
    streamPrefix: 'ecs',
  }),
  environmentFiles: [ecs.EnvironmentFile.fromBucket(environmentBucket, `config/${appEnv}.env`)],
});

container.addPortMappings({
  containerPort: 80,
  protocol: ecs.Protocol.TCP,
});

const fargateService = new ecs.FargateService(this, 'FargateService', {
  cluster: ecsCluster,
  taskDefinition,
  securityGroups: [ecsSecurityGroup],
  desiredCount: 2, // Start with 2 tasks
});

// Auto-scaling for the service
const scalableTarget = fargateService.autoScaleTaskCount({
  minCapacity: 2,
  maxCapacity: 10,
});

scalableTarget.scaleOnCpuUtilization('CpuScaling', {
  targetUtilizationPercent: 70,
});

scalableTarget.scaleOnMemoryUtilization('MemoryScaling', {
  targetUtilizationPercent: 70,
});

// Create an Application Load Balancer
const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'AppLoadBalancer', {
  vpc,
  internetFacing: true,
  securityGroup: ecsSecurityGroup,
  loadBalancerName: `app-alb-${appEnv}`,
});

// HTTP Listener to redirect traffic to HTTPS
const httpListener = loadBalancer.addListener('HttpListener', {
  port: 80,
  open: true,
});
httpListener.addRedirectResponse('RedirectToHttps', {
  statusCode: 'HTTP_301',
  protocol: elbv2.ApplicationProtocol.HTTPS,
  port: '443',
});

// Fetch ACM certificate
const certificate = acm.Certificate.fromCertificateArn(this, 'AppCert', 'arn:aws:acm:region:account:certificate/certificate-id');

// HTTPS Listener
const httpsListener = loadBalancer.addListener('HttpsListener', {
  port: 443,
  open: true,
  certificates: [certificate],
});

// Create a target group
const targetGroup = new elbv2.ApplicationTargetGroup(this, 'AppTargetGroup', {
  vpc,
  targets: [fargateService],
  healthCheck: {
    path: '/',
    interval: cdk.Duration.seconds(30),
  },
});

// Attach Fargate Service to ALB
httpsListener.addTargetGroups('AppTargets', {
  targetGroups: [targetGroup],
});
// Lookup existing hosted zone
const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
  domainName,
});

// Add A record to route traffic to the ALB
new route53.ARecord(this, 'AliasRecord', {
  zone: hostedZone,
  target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(loadBalancer)),
  recordName: appEnv === 'prod' ? 'www' : `${appEnv}`,
});

const s3Bucket = new s3.Bucket(this, 'EnvFilesBucket', {
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  versioned: true,
});