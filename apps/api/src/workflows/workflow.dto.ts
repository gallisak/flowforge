import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, Length, ValidateIf } from 'class-validator';

export class CreateWorkflowDto {
  @IsString()
  @Length(1, 200)
  name: string;

  @IsArray()
  @ArrayNotEmpty()
  steps: unknown[];

  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  cron?: string | null;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateWorkflowDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  steps?: unknown[];

  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  cron?: string | null;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
