import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional, IsString, Length, ValidateIf } from 'class-validator';
import { MISSED_RUN_POLICIES, MissedRunPolicy } from '../scheduler/cron-schedule';

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

  @IsOptional()
  @IsIn(MISSED_RUN_POLICIES)
  missedRunPolicy?: MissedRunPolicy;
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

  @IsOptional()
  @IsIn(MISSED_RUN_POLICIES)
  missedRunPolicy?: MissedRunPolicy;
}
